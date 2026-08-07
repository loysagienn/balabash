// Telegram forum adapter, inbound side (§6, §11.2). A workspace is a forum
// group bound 1:1 to a user; activation is /start from an allowlisted login.
// Messages of ALL members of an activated group are processed: membership is
// the workspace trust boundary. The adapter owns transport state (tables, not
// events) and writes canonical user.message events into threads.

import { Bot, type Context } from 'grammy';
import { run, sequentialize } from '@grammyjs/runner';
import { Readable } from 'node:stream';
import { config } from '../../config/index.ts';
import { prisma } from '../../db/client.ts';
import { appendEvent } from '../../core/append.ts';
import { SYSTEM_EXCEPTION, THREAD_CANCEL } from '../../core/envelope.ts';
import type { ContentBlock, JsonObject } from '../../core/contract.ts';
import { ensureMainThread, getMainThread, getThread } from '../../core/threads.ts';
import { ingestFile, type FileDescriptor } from '../../files/index.ts';

const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Extensions for the document types Telegram commonly delivers. Used only when
// a document arrives without a file_name: a known mime type keeps the stored
// file's extension meaningful, an unknown one falls back to no extension
// rather than the misleading `.jpg` a photo would get.
const DOCUMENT_MIME_EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/json': '.json',
  'application/xml': '.xml',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/html': '.html',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

function buildDocumentFilename(messageId: number, mimeType: string | null): string {
  const normalized = mimeType?.split(';')[0]?.trim().toLowerCase();
  const extension = (normalized && DOCUMENT_MIME_EXTENSIONS[normalized]) || '';

  return `telegram-document-${messageId}${extension}`;
}

function isAllowedLogin(username: string | undefined): boolean {
  return Boolean(username) && config.telegramAllowedLogins.includes(username!.toLowerCase());
}

function identityOf(from: NonNullable<Context['from']>): JsonObject {
  return {
    username: from.username ?? null,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
  };
}

async function getBoundGroup(chatId: number) {
  const group = await prisma.telegramGroup.findUnique({ where: { chatId: BigInt(chatId) } });

  return group?.userId ? { ...group, userId: group.userId } : null;
}

// Resolves the thread a topic message belongs to: General → the main thread,
// a known forum topic → its thread (stage 3), an unknown topic → null (not
// ours; a topic created by hand is outside the surface).
async function resolveThreadId(userId: string, chatId: number, messageThreadId: number | undefined) {
  if (messageThreadId !== undefined) {
    const topic = await prisma.telegramTopic.findUnique({
      where: { chatId_messageThreadId: { chatId: BigInt(chatId), messageThreadId } },
    });

    return topic?.threadId ?? null;
  }

  const mainThread = await getMainThread(userId);

  return mainThread?.id ?? null;
}

export async function initTelegramBot() {
  const bot = new Bot(config.telegramBotToken);

  bot.use(
    sequentialize(ctx => {
      return ctx.chat?.id ? String(ctx.chat.id) : 'global';
    }),
  );

  // The bot lives in groups. Being added to one records an unbound row and
  // nothing else: there is no one to attribute events to until /start (§6).
  bot.on('my_chat_member', async ctx => {
    const chat = ctx.chat;

    if (chat.type !== 'group' && chat.type !== 'supergroup') {
      return;
    }

    const status = ctx.myChatMember.new_chat_member.status;

    if (status === 'member' || status === 'administrator') {
      await prisma.telegramGroup.upsert({
        where: { chatId: BigInt(chat.id) },
        create: { chatId: BigInt(chat.id), status: 'unbound' },
        update: {},
      });
    }
  });

  bot.command('start', async ctx => {
    const chat = ctx.chat;

    if (chat.type === 'private') {
      if (isAllowedLogin(ctx.from?.username)) {
        await ctx.reply('Balabash живёт в группах: создай группу, добавь меня и отправь /start там.');
      }

      return;
    }

    if (chat.type !== 'group' && chat.type !== 'supergroup') {
      return;
    }

    // Activation is gated by the allowlist; everything after activation is
    // gated by group membership instead.
    if (!isAllowedLogin(ctx.from?.username)) {
      return;
    }

    const chatId = BigInt(chat.id);
    const existing = await prisma.telegramGroup.findUnique({ where: { chatId } });

    if (existing?.userId) {
      await ctx.reply('Уже активировано: эта группа привязана к воркспейсу.');

      return;
    }

    const user = await prisma.user.create({ data: {} });

    await prisma.telegramGroup.upsert({
      where: { chatId },
      create: { chatId, userId: user.id, status: 'active' },
      update: { userId: user.id, status: 'active' },
    });

    await ensureMainThread(user.id);

    const forumHint =
      'is_forum' in chat && chat.is_forum
        ? ''
        : '\n\nСовет: включи в группе режим тем (Topics) и дай мне право Manage topics — треды агентов будут открываться отдельными топиками.';

    await ctx.reply(`Воркспейс активирован. Пиши в General — это главный тред.${forumHint}`);
  });

  // Mechanical thread cancellation by the user (§11.2): /cancel inside a
  // topic writes thread.cancel without negotiating with the agent. The
  // feedback is the closure flow itself — the runtime writes the terminal,
  // the delivery consumer posts it and closes the topic.
  bot.command('cancel', async ctx => {
    const chat = ctx.chat;

    if (chat.type !== 'group' && chat.type !== 'supergroup') {
      return;
    }

    const group = await getBoundGroup(chat.id);

    if (!group || !ctx.from || ctx.from.is_bot) {
      return;
    }

    const messageThreadId = ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined;

    if (messageThreadId === undefined) {
      await ctx.reply('Отменять нечего: /cancel работает в топике треда.');

      return;
    }

    const topic = await prisma.telegramTopic.findUnique({
      where: { chatId_messageThreadId: { chatId: BigInt(chat.id), messageThreadId } },
    });

    if (!topic) {
      return;
    }

    const thread = await getThread(topic.threadId);

    if (!thread || !thread.parentId) {
      return;
    }

    if (thread.status !== 'active') {
      await ctx.reply('Тред уже завершён.');

      return;
    }

    // Author of the command is the parent thread (one hop down); the human
    // identity rides in the payload.
    await appendEvent({
      type: THREAD_CANCEL,
      actor: 'user',
      userId: group.userId,
      threadId: thread.parentId,
      targetThreadId: thread.id,
      payload: { reason: 'cancelled_by_user', identity: identityOf(ctx.from) },
    });
  });

  // group → supergroup conversion changes the chat id (it happens when topics
  // are enabled); carry the binding over.
  bot.on('message:migrate_to_chat_id', async ctx => {
    const from = BigInt(ctx.chat.id);
    const to = BigInt(ctx.message.migrate_to_chat_id);

    await prisma.telegramGroup.updateMany({ where: { chatId: from }, data: { chatId: to } });
    await prisma.telegramTopic.updateMany({ where: { chatId: from }, data: { chatId: to } });
  });

  bot.on('message', async ctx => {
    const chat = ctx.chat;

    if (chat.type !== 'group' && chat.type !== 'supergroup') {
      return;
    }

    const group = await getBoundGroup(chat.id);

    if (!group) {
      return;
    }

    const from = ctx.from;

    if (!from || from.is_bot) {
      return;
    }

    const message = ctx.message;
    const messageThreadId = message.is_topic_message ? message.message_thread_id : undefined;
    const threadId = await resolveThreadId(group.userId, chat.id, messageThreadId);

    if (!threadId) {
      return;
    }

    const document = message.document;
    const photo = message.photo?.at(-1);
    const telegramFile = document ?? photo;

    const blocks: ContentBlock[] = [];
    const fileMetas: JsonObject[] = [];

    if (telegramFile) {
      let file: FileDescriptor;

      try {
        if (typeof telegramFile.file_size === 'number' && telegramFile.file_size > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
          throw new Error(
            `Telegram file is too large (${telegramFile.file_size} bytes; limit ${TELEGRAM_DOWNLOAD_LIMIT_BYTES})`,
          );
        }

        const remoteFile = await ctx.api.getFile(telegramFile.file_id);

        if (!remoteFile.file_path) {
          throw new Error('Telegram did not return a file path');
        }

        const response = await fetch(
          `https://api.telegram.org/file/bot${config.telegramBotToken}/${remoteFile.file_path}`,
        );

        if (!response.ok || !response.body) {
          throw new Error(`Telegram file download failed: HTTP ${response.status} ${response.statusText}`);
        }

        const contentType = document?.mime_type ?? (photo ? 'image/jpeg' : null);
        // A document may arrive without file_name, so branch on the document
        // itself: the photo fallback only applies when there is no document.
        const originalFilename = document
          ? (document.file_name ?? buildDocumentFilename(message.message_id, contentType))
          : `telegram-photo-${message.message_id}.jpg`;

        file = await ingestFile({
          body: Readable.fromWeb(response.body as never),
          userId: group.userId,
          originalFilename,
          contentType,
          sizeBytes: telegramFile.file_size ?? null,
          width: photo?.width ?? null,
          height: photo?.height ?? null,
          scope: 'telegram',
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);

        await ctx.reply(`Не удалось получить файл: ${errorMessage}`);
        await appendEvent({
          type: SYSTEM_EXCEPTION,
          actor: 'system',
          userId: group.userId,
          threadId,
          payload: { scope: 'telegram-file-ingest', error: errorMessage },
        }).catch(appendError => {
          console.error('[telegram] failed to journal file ingest error:', appendError);
        });

        return;
      }

      blocks.push(photo && !document ? { type: 'image', fileId: file.id } : { type: 'file', fileId: file.id });
      fileMetas.push({
        fileId: file.id,
        contentType: file.contentType,
        originalFilename: file.originalFilename,
        sizeBytes: file.sizeBytes,
        width: file.width,
        height: file.height,
      });
    }

    const text = message.text ?? message.caption ?? null;

    // Commands belong to the adapter surface, not to threads.
    if (text?.startsWith('/')) {
      return;
    }

    if (!text && !blocks.length) {
      return;
    }

    await appendEvent({
      type: 'user.message',
      actor: 'user',
      userId: group.userId,
      threadId,
      payload: {
        text,
        ...(blocks.length ? { blocks, files: fileMetas } : {}),
        identity: identityOf(from),
      },
    });
  });

  bot.catch(error => {
    console.error('Telegram bot error:', error.error || error);
  });

  run(bot);

  console.log('[telegram] bot is running');

  return bot;
}
