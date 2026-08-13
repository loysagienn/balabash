// Gmail capability over the plain Gmail REST API (v1) with per-user Google
// OAuth. This local MCP server is an OAuth protected resource: its metadata
// points at accounts.google.com, the Balabash runtime runs the whole OAuth
// flow (consent link, PKCE, callback, token storage, refresh), and every
// incoming /mcp request carries the user's Google access token as a Bearer
// header. The token is used directly against the Gmail API and is never kept
// in module state — each request gets its own McpServer bound to that token.
//
// Deliberately NOT the official Gmail MCP developer preview
// (gmailmcp.googleapis.com): a previous run proved the preview API cannot be
// enabled for this installation's Google project, while the plain Gmail API
// is generally available.

import crypto from 'node:crypto';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { toErrorResult, toStructuredResult } from '../src/capabilities/tool-result.ts';
import type { FileRef } from '../src/core/contract.ts';

type ToolFilesApi = {
  ingest: (input: {
    body: NodeJS.ReadableStream | Buffer | Uint8Array | string;
    userId?: string | null;
    originalFilename?: string | null;
    contentType?: string | null;
    sizeBytes?: number | null;
  }) => Promise<FileRef>;
};

// The calling run's identity rides in the MCP request _meta (set by the tool
// manager for local servers). A stored file must belong to that workspace —
// an ownerless file cannot be delivered back to the user.
function callerUserId(extra: { _meta?: Record<string, unknown> }): string | null {
  const balabash = extra._meta?.balabash;
  const userId =
    balabash && typeof balabash === 'object' && !Array.isArray(balabash)
      ? (balabash as Record<string, unknown>).userId
      : undefined;

  return typeof userId === 'string' && userId ? userId : null;
}

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_AUTHORIZATION_SERVER = 'https://accounts.google.com';

// Minimum scopes covering the capability: search/read (readonly) plus
// drafts and sending (compose). No gmail.modify — labels/trash are out of
// scope for this capability.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

const MESSAGE_BODY_LIMIT = 20_000;
const THREAD_MESSAGE_BODY_LIMIT = 8_000;
const THREAD_MESSAGE_LIMIT = 15;
const SEARCH_MAX_RESULTS_LIMIT = 25;

// ---------------------------------------------------------------------------
// Gmail REST helpers
// ---------------------------------------------------------------------------

type GmailHeader = { name?: string; value?: string };

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};

type GmailMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
};

class GmailApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function gmailFetch(
  accessToken: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Record<string, unknown>> {
  const method = init?.method ?? 'GET';
  const response = await fetch(`${GMAIL_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();

  if (!response.ok) {
    // Surface the provider's own diagnostics verbatim: a bare status code has
    // already caused wrong blind diagnoses in this installation.
    let detail = text.slice(0, 1_000);

    try {
      const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } };

      if (parsed?.error?.message) {
        detail = `${parsed.error.status ? `${parsed.error.status}: ` : ''}${parsed.error.message}`;
      }
    } catch {
      // Keep the raw body.
    }

    const hint =
      response.status === 401
        ? ' The Google access token was rejected mid-call (likely revoked). Ask the user to re-authorize via request_authorization.'
        : response.status === 403
          ? ' Check that the Gmail API is enabled in the Google Cloud project of the OAuth client and that the granted scopes include gmail.readonly and gmail.compose.'
          : '';

    throw new GmailApiError(`Gmail API ${response.status} on ${method} ${path.split('?')[0]}: ${detail}${hint}`, response.status);
  }

  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Message parsing (payload -> readable text)
// ---------------------------------------------------------------------------

function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  const lower = name.toLowerCase();
  const match = headers?.find(header => header.name?.toLowerCase() === lower);

  return match?.value ?? null;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function htmlToText(html: string): string {
  const text = html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeHtmlEntities(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type ParsedAttachment = {
  filename: string;
  part_id: string | null;
  mime_type: string | null;
  size_bytes: number | null;
};

type ExtractedContent = { plain: string[]; html: string[]; attachments: ParsedAttachment[] };

function walkParts(part: GmailPart | undefined, out: ExtractedContent): void {
  if (!part) {
    return;
  }

  if (part.filename) {
    out.attachments.push({
      filename: part.filename,
      part_id: part.partId ?? null,
      mime_type: part.mimeType ?? null,
      size_bytes: part.body?.size ?? null,
    });
  } else if (part.body?.data) {
    if (part.mimeType?.toLowerCase().startsWith('text/plain')) {
      out.plain.push(decodeBase64Url(part.body.data));
    } else if (part.mimeType?.toLowerCase().startsWith('text/html')) {
      out.html.push(decodeBase64Url(part.body.data));
    }
  }

  for (const child of part.parts ?? []) {
    walkParts(child, out);
  }
}

// Attachment parts of a message payload, in document order. Used to resolve a
// filename from an earlier listing back to the part holding the current
// attachmentId: Gmail attachmentIds are ephemeral and oversized, so they are
// re-resolved on demand and never appear in tool results.
function collectAttachmentParts(part: GmailPart | undefined, out: GmailPart[] = []): GmailPart[] {
  if (!part) {
    return out;
  }

  if (part.filename) {
    out.push(part);
  }

  for (const child of part.parts ?? []) {
    collectAttachmentParts(child, out);
  }

  return out;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} characters]`;
}

function parseMessage(message: GmailMessage, bodyLimit: number): Record<string, unknown> {
  const headers = message.payload?.headers;
  const extracted: ExtractedContent = { plain: [], html: [], attachments: [] };

  walkParts(message.payload, extracted);

  const body = extracted.plain.length
    ? extracted.plain.join('\n')
    : extracted.html.length
      ? htmlToText(extracted.html.join('\n'))
      : '';

  return {
    message_id: message.id ?? null,
    thread_id: message.threadId ?? null,
    label_ids: message.labelIds ?? [],
    date: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
    from: headerValue(headers, 'From'),
    to: headerValue(headers, 'To'),
    cc: headerValue(headers, 'Cc'),
    subject: headerValue(headers, 'Subject'),
    rfc822_message_id: headerValue(headers, 'Message-ID'),
    body: truncate(body, bodyLimit),
    attachments: extracted.attachments,
  };
}

// ---------------------------------------------------------------------------
// Outgoing mail (RFC 2822 -> base64url raw)
// ---------------------------------------------------------------------------

function encodeHeaderText(value: string): string {
  // RFC 2047 encoded-word for non-ASCII header text (e.g. Cyrillic subjects).
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

type OutgoingMessage = {
  to: string[];
  cc?: string[] | null;
  bcc?: string[] | null;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
};

function buildRawEmail(message: OutgoingMessage): string {
  const headers = [`To: ${message.to.join(', ')}`];

  if (message.cc?.length) {
    headers.push(`Cc: ${message.cc.join(', ')}`);
  }

  if (message.bcc?.length) {
    headers.push(`Bcc: ${message.bcc.join(', ')}`);
  }

  headers.push(`Subject: ${encodeHeaderText(message.subject)}`);

  if (message.inReplyTo) {
    headers.push(`In-Reply-To: ${message.inReplyTo}`);
  }

  if (message.references) {
    headers.push(`References: ${message.references}`);
  }

  headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');

  const encodedBody = Buffer.from(message.body, 'utf8').toString('base64');
  const foldedBody = encodedBody.match(/.{1,76}/g)?.join('\r\n') ?? '';
  const mime = `${headers.join('\r\n')}\r\n\r\n${foldedBody}`;

  return Buffer.from(mime, 'utf8').toString('base64url');
}

type ComposeArguments = {
  to: string[];
  cc?: string[] | null;
  bcc?: string[] | null;
  subject?: string | null;
  body: string;
  reply_to_message_id?: string | null;
};

// Resolves reply threading (In-Reply-To / References / threadId / derived
// subject) and produces the Gmail message resource for drafts and sends.
async function buildOutgoingResource(
  accessToken: string,
  args: ComposeArguments,
): Promise<{ raw: string; threadId?: string }> {
  let inReplyTo: string | null = null;
  let references: string | null = null;
  let threadId: string | undefined;
  let subject = args.subject ?? null;

  if (args.reply_to_message_id) {
    const original = (await gmailFetch(
      accessToken,
      `/messages/${encodeURIComponent(args.reply_to_message_id)}?format=metadata` +
        '&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References',
    )) as GmailMessage;
    const originalMessageId = headerValue(original.payload?.headers, 'Message-ID');
    const originalReferences = headerValue(original.payload?.headers, 'References');
    const originalSubject = headerValue(original.payload?.headers, 'Subject');

    threadId = original.threadId ?? undefined;
    inReplyTo = originalMessageId;
    references = [originalReferences, originalMessageId].filter(Boolean).join(' ') || null;

    if (!subject && originalSubject) {
      subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
    }
  }

  if (!subject) {
    throw new Error(
      'subject is required (it can only be omitted when reply_to_message_id points to a message that has a Subject header)',
    );
  }

  return {
    raw: buildRawEmail({ ...args, subject, inReplyTo, references }),
    ...(threadId ? { threadId } : {}),
  };
}

// ---------------------------------------------------------------------------
// MCP server (one instance per request, bound to that request's token)
// ---------------------------------------------------------------------------

const composeInputShape = {
  to: z.array(z.string()).min(1).describe('Recipient email addresses, e.g. ["anna@example.com"].'),
  cc: z.array(z.string()).nullable().optional().describe('CC addresses. Omit or pass null for none.'),
  bcc: z.array(z.string()).nullable().optional().describe('BCC addresses. Omit or pass null for none.'),
  subject: z
    .string()
    .nullable()
    .optional()
    .describe('Subject line (UTF-8 allowed). Required unless replying — a reply defaults to "Re: <original subject>".'),
  body: z.string().describe('Plain-text message body (UTF-8). HTML and attachments are not supported.'),
  reply_to_message_id: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Gmail message ID being replied to (from gmail_search_emails / gmail_get_thread). Sets correct reply threading (same thread, In-Reply-To/References). Omit for a new conversation.',
    ),
};

function createMcpServer(accessToken: string, filesApi: ToolFilesApi): McpServer {
  const server = new McpServer({ name: 'gmail', version: '1.0.0' });

  server.registerTool(
    'gmail_search_emails',
    {
      description:
        "Search the user's Gmail mailbox with Gmail query syntax (e.g. 'from:anna@example.com', 'subject:invoice newer_than:7d', 'is:unread', 'in:sent'). Returns message summaries: message_id, thread_id, from, to, subject, date, snippet. Use gmail_get_message or gmail_get_thread to read full content.",
      inputSchema: {
        query: z.string().describe('Gmail search query, same syntax as the Gmail search box.'),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_MAX_RESULTS_LIMIT)
          .nullable()
          .optional()
          .describe(`How many messages to return, 1-${SEARCH_MAX_RESULTS_LIMIT}. Default 10.`),
        page_token: z
          .string()
          .nullable()
          .optional()
          .describe('next_page_token from a previous result to fetch the next page.'),
      },
    },
    async ({ query, max_results, page_token }) => {
      try {
        const params = new URLSearchParams({ q: query, maxResults: String(max_results ?? 10) });

        if (page_token) {
          params.set('pageToken', page_token);
        }

        const list = await gmailFetch(accessToken, `/messages?${params.toString()}`);
        const found = Array.isArray(list.messages) ? (list.messages as GmailMessage[]) : [];
        const messages = await Promise.all(
          found.map(async item => {
            const message = (await gmailFetch(
              accessToken,
              `/messages/${encodeURIComponent(item.id ?? '')}?format=metadata` +
                '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date',
            )) as GmailMessage;

            return {
              message_id: message.id ?? null,
              thread_id: message.threadId ?? null,
              date: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
              from: headerValue(message.payload?.headers, 'From'),
              to: headerValue(message.payload?.headers, 'To'),
              subject: headerValue(message.payload?.headers, 'Subject'),
              snippet: message.snippet ?? null,
              label_ids: message.labelIds ?? [],
            };
          }),
        );

        return toStructuredResult({
          query,
          result_size_estimate: list.resultSizeEstimate ?? null,
          next_page_token: list.nextPageToken ?? null,
          messages,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'gmail_get_message',
    {
      description:
        'Read one Gmail message in full: headers (from, to, cc, subject, date), plain-text body (HTML converted to text, long bodies truncated) and the attachment list (filename, part_id, mime type, size). Attachment contents are not included — download one with gmail_get_attachment when actually needed.',
      inputSchema: {
        message_id: z.string().describe('Gmail message ID, e.g. from gmail_search_emails.'),
      },
    },
    async ({ message_id }) => {
      try {
        const message = (await gmailFetch(
          accessToken,
          `/messages/${encodeURIComponent(message_id)}?format=full`,
        )) as GmailMessage;

        return toStructuredResult(parseMessage(message, MESSAGE_BODY_LIMIT));
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'gmail_get_thread',
    {
      description:
        `Read a whole Gmail conversation (thread): every message with headers and plain-text body. Only the last ${THREAD_MESSAGE_LIMIT} messages of very long threads are included (older ones are counted, not shown).`,
      inputSchema: {
        thread_id: z.string().describe('Gmail thread ID, e.g. from gmail_search_emails.'),
      },
    },
    async ({ thread_id }) => {
      try {
        const thread = await gmailFetch(accessToken, `/threads/${encodeURIComponent(thread_id)}?format=full`);
        const all = Array.isArray(thread.messages) ? (thread.messages as GmailMessage[]) : [];
        const shown = all.slice(-THREAD_MESSAGE_LIMIT);

        return toStructuredResult({
          thread_id,
          message_count: all.length,
          omitted_older_messages: all.length - shown.length,
          messages: shown.map(message => parseMessage(message, THREAD_MESSAGE_BODY_LIMIT)),
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'gmail_get_attachment',
    {
      description:
        'Download one attachment of a Gmail message into Balabash file storage and return its FileRef (id, originalFilename, contentType, sizeBytes, …). Call it only when the attachment contents are actually needed — the attachment list of gmail_get_message already shows filenames and sizes. The returned id is a Balabash fileId: pass it to storage_get_file, send it to the user with send_file, or attach it via fileIds arguments.',
      inputSchema: {
        message_id: z.string().describe('Gmail message ID the attachment belongs to.'),
        filename: z
          .string()
          .describe('Attachment filename exactly as listed by gmail_get_message / gmail_get_thread.'),
        part_id: z
          .string()
          .nullable()
          .optional()
          .describe(
            'part_id from the attachment listing. Only needed when several attachments of the message share the same filename.',
          ),
      },
    },
    async ({ message_id, filename, part_id }, extra) => {
      try {
        const message = (await gmailFetch(
          accessToken,
          `/messages/${encodeURIComponent(message_id)}?format=full`,
        )) as GmailMessage;
        const attachmentParts = collectAttachmentParts(message.payload);
        const matches = attachmentParts.filter(part =>
          part_id ? part.partId === part_id : part.filename === filename,
        );

        if (!matches.length) {
          const available = attachmentParts.map(part => ({
            filename: part.filename,
            part_id: part.partId ?? null,
          }));

          throw new Error(
            `No attachment ${part_id ? `with part_id ${JSON.stringify(part_id)}` : JSON.stringify(filename)} ` +
              `in message ${message_id}. Attachments present: ${JSON.stringify(available)}`,
          );
        }

        if (matches.length > 1) {
          throw new Error(
            `Message ${message_id} has ${matches.length} attachments named ${JSON.stringify(filename)}. ` +
              `Disambiguate with part_id: ${JSON.stringify(matches.map(part => part.partId ?? null))}`,
          );
        }

        const part = matches[0];
        let data = part.body?.data ?? null;

        // Larger attachments are not inlined into format=full — only their
        // attachmentId is, and the bytes come from a dedicated endpoint.
        if (!data && part.body?.attachmentId) {
          const attachment = (await gmailFetch(
            accessToken,
            `/messages/${encodeURIComponent(message_id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
          )) as { data?: string };

          data = attachment.data ?? null;
        }

        if (!data) {
          throw new Error(`Gmail returned no content for attachment ${JSON.stringify(filename)} of message ${message_id}`);
        }

        const body = Buffer.from(data, 'base64url');
        const file = await filesApi.ingest({
          body,
          userId: callerUserId(extra),
          originalFilename: part.filename ?? filename,
          contentType: part.mimeType ?? null,
          sizeBytes: body.length,
        });

        // The one FileRef (§9), verbatim from the files layer.
        return toStructuredResult(file);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'gmail_create_draft',
    {
      description:
        'Create a Gmail draft (new email or a reply in an existing thread). Nothing is sent: the user can review it in Gmail, or it can be sent later with gmail_send_draft. Returns the draft_id.',
      inputSchema: composeInputShape,
    },
    async args => {
      try {
        const resource = await buildOutgoingResource(accessToken, args);
        const draft = await gmailFetch(accessToken, '/drafts', {
          method: 'POST',
          body: { message: resource },
        });
        const message = (draft.message ?? {}) as GmailMessage;

        return toStructuredResult({
          draft_id: draft.id ?? null,
          message_id: message.id ?? null,
          thread_id: message.threadId ?? null,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'gmail_list_drafts',
    {
      description: 'List Gmail drafts with their draft_id, recipient, subject and snippet.',
      inputSchema: {
        max_results: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_MAX_RESULTS_LIMIT)
          .nullable()
          .optional()
          .describe(`How many drafts to return, 1-${SEARCH_MAX_RESULTS_LIMIT}. Default 10.`),
      },
    },
    async ({ max_results }) => {
      try {
        const list = await gmailFetch(accessToken, `/drafts?maxResults=${max_results ?? 10}`);
        const found = Array.isArray(list.drafts) ? (list.drafts as Array<{ id?: string }>) : [];
        const drafts = await Promise.all(
          found.map(async item => {
            const draft = await gmailFetch(
              accessToken,
              `/drafts/${encodeURIComponent(item.id ?? '')}?format=metadata`,
            );
            const message = (draft.message ?? {}) as GmailMessage;

            return {
              draft_id: draft.id ?? null,
              thread_id: message.threadId ?? null,
              to: headerValue(message.payload?.headers, 'To'),
              subject: headerValue(message.payload?.headers, 'Subject'),
              snippet: message.snippet ?? null,
            };
          }),
        );

        return toStructuredResult({ drafts });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'gmail_update_draft',
    {
      description:
        'Replace the content of an existing Gmail draft (recipients, subject and body must all be provided again — the draft is fully rewritten).',
      inputSchema: {
        draft_id: z.string().describe('Draft ID from gmail_create_draft or gmail_list_drafts.'),
        ...composeInputShape,
      },
    },
    async ({ draft_id, ...args }) => {
      try {
        const resource = await buildOutgoingResource(accessToken, args);
        const draft = await gmailFetch(accessToken, `/drafts/${encodeURIComponent(draft_id)}`, {
          method: 'PUT',
          body: { message: resource },
        });
        const message = (draft.message ?? {}) as GmailMessage;

        return toStructuredResult({
          draft_id: draft.id ?? null,
          message_id: message.id ?? null,
          thread_id: message.threadId ?? null,
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'gmail_send_draft',
    {
      description:
        'Send an existing Gmail draft. This actually delivers the email — confirm with the user before calling it.',
      inputSchema: {
        draft_id: z.string().describe('Draft ID from gmail_create_draft or gmail_list_drafts.'),
      },
    },
    async ({ draft_id }) => {
      try {
        const sent = (await gmailFetch(accessToken, '/drafts/send', {
          method: 'POST',
          body: { id: draft_id },
        })) as GmailMessage;

        return toStructuredResult({ sent: true, message_id: sent.id ?? null, thread_id: sent.threadId ?? null });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'gmail_send_email',
    {
      description:
        'Compose and immediately send an email from the user\'s Gmail account (new email or a reply in an existing thread). This actually delivers the email — confirm recipients, subject and body with the user before calling it. Prefer gmail_create_draft when the user wants to review first.',
      inputSchema: composeInputShape,
    },
    async args => {
      try {
        const resource = await buildOutgoingResource(accessToken, args);
        const sent = (await gmailFetch(accessToken, '/messages/send', {
          method: 'POST',
          body: resource,
        })) as GmailMessage;

        return toStructuredResult({ sent: true, message_id: sent.id ?? null, thread_id: sent.threadId ?? null });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Bearer token validation (Google tokeninfo, short-lived cache)
// ---------------------------------------------------------------------------

// Cache keyed by token hash so no token value sits in module state. An entry
// only records "this token was valid until T".
const tokenValidityCache = new Map<string, number>();
const TOKEN_CACHE_MAX_TTL_MS = 10 * 60 * 1000;
const TOKEN_CACHE_SAFETY_MS = 30 * 1000;
const TOKEN_CACHE_MAX_ENTRIES = 500;

function pruneTokenCache(): void {
  const now = Date.now();

  for (const [key, validUntil] of tokenValidityCache) {
    if (validUntil <= now) {
      tokenValidityCache.delete(key);
    }
  }

  while (tokenValidityCache.size > TOKEN_CACHE_MAX_ENTRIES) {
    const oldest = tokenValidityCache.keys().next().value;

    if (oldest === undefined) {
      break;
    }

    tokenValidityCache.delete(oldest);
  }
}

async function isAccessTokenValid(accessToken: string): Promise<boolean> {
  const key = crypto.createHash('sha256').update(accessToken).digest('base64');
  const cached = tokenValidityCache.get(key);

  if (cached !== undefined && cached > Date.now()) {
    return true;
  }

  let response: Response;

  try {
    response = await fetch(TOKENINFO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: accessToken }),
    });
  } catch {
    // tokeninfo unreachable: fail open — if the token is actually bad, the
    // Gmail API call itself will report it clearly.
    return true;
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});

    return false;
  }

  const info = (await response.json().catch(() => ({}))) as { expires_in?: string | number };
  const expiresInMs = Number(info.expires_in ?? 0) * 1000;
  const ttl = Math.min(expiresInMs - TOKEN_CACHE_SAFETY_MS, TOKEN_CACHE_MAX_TTL_MS);

  if (ttl > 0) {
    pruneTokenCache();
    tokenValidityCache.set(key, Date.now() + ttl);
  }

  return true;
}

// ---------------------------------------------------------------------------
// HTTP endpoint: protected-resource metadata + authenticated /mcp
// ---------------------------------------------------------------------------

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8');

  return body ? JSON.parse(body) : undefined;
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown, headers?: Record<string, string>): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(payload));
}

function sendUnauthorized(response: http.ServerResponse, origin: string, description: string): void {
  sendJson(
    response,
    401,
    { error: 'invalid_token', error_description: description },
    {
      'www-authenticate':
        `Bearer error="invalid_token", error_description="${description}", ` +
        `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    },
  );
}

export async function start(ctx: { filesApi: ToolFilesApi }) {
  const httpServer = http.createServer(async (request, response) => {
    const origin = `http://${request.headers.host ?? '127.0.0.1'}`;
    const pathname = new URL(request.url ?? '/', origin).pathname;

    // RFC 9728 protected resource metadata: tells the Balabash OAuth client
    // that the authorization server for this resource is Google. Both the
    // path-aware and the root well-known locations are served.
    if (
      request.method === 'GET' &&
      (pathname === '/.well-known/oauth-protected-resource/mcp' || pathname === '/.well-known/oauth-protected-resource')
    ) {
      sendJson(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [GOOGLE_AUTHORIZATION_SERVER],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header'],
      });
      return;
    }

    if (pathname !== '/mcp' || request.method !== 'POST') {
      sendJson(response, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      });
      return;
    }

    const bearerMatch = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '');
    const accessToken = bearerMatch?.[1]?.trim();

    if (!accessToken) {
      sendUnauthorized(response, origin, 'Missing bearer token');
      return;
    }

    if (!(await isAccessTokenValid(accessToken))) {
      // An expired access token: the 401 makes the Balabash MCP client
      // refresh it with the stored refresh token and retry transparently.
      sendUnauthorized(response, origin, 'Google access token is invalid or expired');
      return;
    }

    const server = createMcpServer(accessToken, ctx.filesApi);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      const body = await readJsonBody(request);

      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          id: null,
        });
      }
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();

  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    throw new Error('Local MCP server did not receive a TCP port');
  }

  return {
    config: {
      transport: 'http' as const,
      url: `http://127.0.0.1:${address.port}/mcp`,
      auth: 'user' as const,
      description:
        "Gmail integration over the plain Gmail REST API. Each user connects their own Google account through a one-time OAuth link; until then no Gmail tools are available for them. After authorization it can: search mail with Gmail query syntax (gmail_search_emails), read full messages and threads as plain text (gmail_get_message, gmail_get_thread), download a message attachment into Balabash file storage as a fileId (gmail_get_attachment), create/update/list plain-text drafts including replies in a thread (gmail_create_draft, gmail_update_draft, gmail_list_drafts), and send mail (gmail_send_draft, gmail_send_email) — always confirm with the user before sending. Outgoing attachments and HTML composition are not supported. Requested Google scopes: gmail.readonly and gmail.compose. Operator prerequisite (one-time, before the first authorization): a Google Cloud project with the Gmail API enabled and an OAuth 2.0 'Web application' client whose authorized redirect URI is https://<balabash-domain>/oauth/callback; provision its client ID and secret via request_oauth_client_credentials. While that Google OAuth app is in Testing mode, Google expires refresh tokens after 7 days and users must re-authorize weekly; publishing the app removes this limit.",
      clientRegistration: 'manual' as const,
      scope: SCOPES.join(' '),
      authorizationParams: {
        // Google only issues a refresh token for offline access, and only
        // reliably on a consent-prompted flow; without these the connection
        // dies as soon as the first access token expires.
        access_type: 'offline',
        prompt: 'consent',
      },
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close(error => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}
