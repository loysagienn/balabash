// Telegram forum adapter, outbound side (§11.2): a consumer delivering
// agent.message (and system.exception, for operability) into the group.
// At-least-once delivery is made idempotent by telegram_deliveries: an event
// with a recorded delivery is skipped on redelivery.

import type { Bot } from 'grammy';
import { prisma } from '../../db/client.ts';
import { startConsumer } from '../../core/consumers.ts';
import type { Consumer } from '../../core/consumers.ts';
import type { ContentBlock, Event } from '../../core/contract.ts';
import { getThread } from '../../core/threads.ts';
import { getFileDownloadUrl } from '../../files/index.ts';
import { formatTelegramMarkdown, TELEGRAM_MESSAGE_LIMIT } from './format.ts';

type DeliveryTarget = {
  chatId: bigint;
  messageThreadId: number | null;
};

// Thread → forum topic; the main thread lives in General (no topic id).
async function resolveTarget(event: Event): Promise<DeliveryTarget | null> {
  if (!event.threadId || !event.userId) {
    return null;
  }

  const topic = await prisma.telegramTopic.findUnique({ where: { threadId: event.threadId } });

  if (topic) {
    return { chatId: topic.chatId, messageThreadId: topic.messageThreadId };
  }

  const thread = await getThread(event.threadId);

  if (!thread || thread.parentId !== null) {
    // A child thread without a topic mapping: nothing to deliver to yet
    // (topics appear at stage 3).
    return null;
  }

  const group = await prisma.telegramGroup.findFirst({ where: { userId: event.userId } });

  return group ? { chatId: group.chatId, messageThreadId: null } : null;
}

async function alreadyDelivered(eventId: string): Promise<boolean> {
  const delivery = await prisma.telegramDelivery.findFirst({ where: { eventId } });

  return delivery !== null;
}

async function recordDelivery(eventId: string, target: DeliveryTarget, messageId: number): Promise<void> {
  await prisma.telegramDelivery.create({
    data: {
      eventId,
      chatId: target.chatId,
      messageThreadId: target.messageThreadId,
      messageId: BigInt(messageId),
    },
  });
}

function contentBlocks(event: Event): ContentBlock[] {
  const content = event.payload.content;

  return Array.isArray(content) ? (content as unknown as ContentBlock[]) : [];
}

export function startTelegramDelivery({ bot }: { bot: Bot }): Consumer {
  return startConsumer({
    name: 'telegram-delivery',
    types: () => ['agent.message', 'system.exception'],
    handler: async event => {
      const target = await resolveTarget(event);

      if (!target) {
        return;
      }

      if (await alreadyDelivered(event.id)) {
        return;
      }

      const chatId = Number(target.chatId);
      const threadOptions = target.messageThreadId !== null ? { message_thread_id: target.messageThreadId } : {};

      if (event.type === 'system.exception') {
        // Operability surface, best-effort: a failure to render an exception
        // must not spin the consumer's own error loop.
        try {
          const sent = await bot.api.sendMessage(
            chatId,
            `system.exception:\n${JSON.stringify(event.payload, null, 2).slice(0, TELEGRAM_MESSAGE_LIMIT - 100)}`,
            threadOptions,
          );

          await recordDelivery(event.id, target, sent.message_id);
        } catch (error) {
          console.error(`[telegram-delivery] failed to send exception ${event.id}:`, error);
        }

        return;
      }

      const blocks = contentBlocks(event);
      const text = blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n\n');
      const fileBlocks = blocks.filter(block => block.type === 'image' || block.type === 'file');

      let firstMessageId: number | null = null;

      for (const chunk of formatTelegramMarkdown(text, TELEGRAM_MESSAGE_LIMIT)) {
        const sent = await bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML', ...threadOptions });

        firstMessageId ??= sent.message_id;
      }

      for (const block of fileBlocks) {
        const { url } = await getFileDownloadUrl(block.fileId);
        const sent = await bot.api.sendDocument(chatId, url, threadOptions);

        firstMessageId ??= sent.message_id;
      }

      if (firstMessageId !== null) {
        await recordDelivery(event.id, target, firstMessageId);
      }
    },
  });
}
