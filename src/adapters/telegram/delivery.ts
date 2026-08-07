// Telegram forum adapter, outbound side (§11.2): a consumer delivering the
// thread surface into the group — agent.message into topics, child-thread
// lifecycle as forum topics (created on thread.started, closed with the
// summary on a terminal), thread.notification by level (§11.3), and
// system.exception for operability. At-least-once delivery is made
// idempotent by telegram_deliveries: an event with a recorded delivery is
// skipped on redelivery. thread.progress is deliberately not delivered: a
// live topic already shows the work through agent.message — progress feeds
// the parent's context and thread lists, not the chat (§11.2).

import type { Bot } from 'grammy';
import { prisma } from '../../db/client.ts';
import { startConsumer } from '../../core/consumers.ts';
import type { Consumer } from '../../core/consumers.ts';
import type { ContentBlock, Event, ThreadSummary } from '../../core/contract.ts';
import { TERMINAL_TYPES, THREAD_NOTIFICATION, THREAD_STARTED } from '../../core/envelope.ts';
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
    // A child thread without a topic mapping: topic creation failed or the
    // group has no forum mode — nothing to deliver to.
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

function threadOptionsOf(target: DeliveryTarget): { message_thread_id?: number } {
  return target.messageThreadId !== null ? { message_thread_id: target.messageThreadId } : {};
}

// Deep link into a topic of a private supergroup: t.me/c/<internal id>/<topic>.
function topicLink(chatId: bigint, messageThreadId: number): string | null {
  const raw = chatId.toString();

  return raw.startsWith('-100') ? `https://t.me/c/${raw.slice(4)}/${messageThreadId}` : null;
}

export function startTelegramDelivery({ bot }: { bot: Bot }): Consumer {
  const sendText = async (
    target: DeliveryTarget,
    text: string,
    extra: { disable_notification?: boolean } = {},
  ): Promise<number | null> => {
    let firstMessageId: number | null = null;

    for (const chunk of formatTelegramMarkdown(text, TELEGRAM_MESSAGE_LIMIT)) {
      const sent = await bot.api.sendMessage(Number(target.chatId), chunk, {
        parse_mode: 'HTML',
        ...threadOptionsOf(target),
        ...extra,
      });

      firstMessageId ??= sent.message_id;
    }

    return firstMessageId;
  };

  // Birth of a child thread → a forum topic. Failure to create one (no forum
  // mode, missing Manage topics right) is journaled loudly: without the
  // mapping the whole child conversation has nowhere to go.
  const handleThreadStarted = async (event: Event): Promise<void> => {
    if (!event.targetThreadId || !event.threadId || !event.userId) {
      // A main thread lives in General; no topic to create.
      return;
    }

    // A headless thread has no user surface by declaration: no topic, and
    // with no telegram_topics row every later delivery skips it naturally.
    // The agent talks to its parent; the coordinator relays what matters.
    if (event.payload.headless === true) {
      return;
    }

    if (await alreadyDelivered(event.id)) {
      return;
    }

    const group = await prisma.telegramGroup.findFirst({ where: { userId: event.userId } });

    if (!group) {
      return;
    }

    const title = typeof event.payload.title === 'string' && event.payload.title ? event.payload.title : 'thread';
    const icon = typeof event.payload.icon === 'string' && event.payload.icon ? `${event.payload.icon} ` : '';
    const chatId = Number(group.chatId);

    try {
      const topic = await bot.api.createForumTopic(chatId, `${icon}${title}`.slice(0, 128));

      await prisma.telegramTopic.create({
        data: {
          threadId: event.threadId,
          chatId: group.chatId,
          messageThreadId: topic.message_thread_id,
        },
      });

      await recordDelivery(
        event.id,
        { chatId: group.chatId, messageThreadId: topic.message_thread_id },
        topic.message_thread_id,
      );
    } catch (error) {
      console.error(`[telegram-delivery] failed to create topic for thread ${event.threadId}:`, error);

      // Visible in General through the system.exception delivery below.
      throw new Error(
        `Не удалось создать топик для треда (нужен режим тем и право Manage topics): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  // A terminal closes the topic; the summary is its last message — closed
  // topics are the readable archive (§11.2).
  const handleTerminal = async (event: Event): Promise<void> => {
    if (!event.threadId) {
      return;
    }

    const topic = await prisma.telegramTopic.findUnique({ where: { threadId: event.threadId } });

    if (!topic || topic.messageThreadId === null) {
      return;
    }

    if (await alreadyDelivered(event.id)) {
      return;
    }

    const target: DeliveryTarget = { chatId: topic.chatId, messageThreadId: topic.messageThreadId };

    let text: string;
    let fileIds: string[] = [];

    if (event.type === 'thread.completed') {
      const summary = event.payload.summary as ThreadSummary | undefined;

      text = `✅ ${summary?.text ?? 'Готово.'}`;
      fileIds = summary?.fileIds ?? [];
    } else if (event.type === 'thread.failed') {
      text = `⚠️ Тред завершился с ошибкой: ${typeof event.payload.error === 'string' ? event.payload.error : 'unknown'}`;
    } else {
      const reason = typeof event.payload.reason === 'string' ? event.payload.reason : null;

      text = `⛔ Тред отменён${reason ? ` (${reason})` : ''}.`;
    }

    const firstMessageId = await sendText(target, text);

    for (const fileId of fileIds) {
      try {
        const { url } = await getFileDownloadUrl(fileId);

        await bot.api.sendDocument(Number(target.chatId), url, threadOptionsOf(target));
      } catch (error) {
        console.error(`[telegram-delivery] failed to send summary file ${fileId}:`, error);
      }
    }

    try {
      await bot.api.closeForumTopic(Number(target.chatId), topic.messageThreadId);
    } catch (error) {
      // Best-effort: an already-closed or unclosable topic must not spin the
      // consumer.
      console.error(`[telegram-delivery] failed to close topic ${topic.messageThreadId}:`, error);
    }

    if (firstMessageId !== null) {
      await recordDelivery(event.id, target, firstMessageId);
    }
  };

  // The attention plane (§11.3): urgent breaks out into General with a link,
  // normal relies on the user's native per-topic mute, silent never rings.
  const handleNotification = async (event: Event): Promise<void> => {
    const target = await resolveTarget(event);

    if (!target) {
      return;
    }

    if (await alreadyDelivered(event.id)) {
      return;
    }

    const level = typeof event.payload.level === 'string' ? event.payload.level : 'normal';
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';

    if (!text) {
      return;
    }

    const firstMessageId = await sendText(target, `🔔 ${text}`, {
      ...(level === 'silent' ? { disable_notification: true } : {}),
    });

    if (level === 'urgent' && target.messageThreadId !== null) {
      const link = topicLink(target.chatId, target.messageThreadId);

      await sendText(
        { chatId: target.chatId, messageThreadId: null },
        `🔔 ${text}${link ? `\n\n→ [топик](${link})` : ''}`,
      );
    }

    if (firstMessageId !== null) {
      await recordDelivery(event.id, target, firstMessageId);
    }
  };

  return startConsumer({
    name: 'telegram-delivery',
    types: () => [
      'agent.message',
      'system.exception',
      THREAD_STARTED,
      THREAD_NOTIFICATION,
      ...TERMINAL_TYPES,
    ],
    handler: async event => {
      if (event.type === THREAD_STARTED) {
        return handleThreadStarted(event);
      }

      if (TERMINAL_TYPES.has(event.type)) {
        return handleTerminal(event);
      }

      if (event.type === THREAD_NOTIFICATION) {
        return handleNotification(event);
      }

      const target = await resolveTarget(event);

      if (!target) {
        return;
      }

      if (await alreadyDelivered(event.id)) {
        return;
      }

      if (event.type === 'system.exception') {
        // Operability surface, best-effort: a failure to render an exception
        // must not spin the consumer's own error loop.
        try {
          const sent = await bot.api.sendMessage(
            Number(target.chatId),
            `system.exception:\n${JSON.stringify(event.payload, null, 2).slice(0, TELEGRAM_MESSAGE_LIMIT - 100)}`,
            threadOptionsOf(target),
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

      let firstMessageId = text ? await sendText(target, text) : null;

      for (const block of fileBlocks) {
        const { url } = await getFileDownloadUrl(block.fileId);
        const sent = await bot.api.sendDocument(Number(target.chatId), url, threadOptionsOf(target));

        firstMessageId ??= sent.message_id;
      }

      if (firstMessageId !== null) {
        await recordDelivery(event.id, target, firstMessageId);
      }
    },
  });
}
