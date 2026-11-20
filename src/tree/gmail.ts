// The node `gmail`: the user's Gmail over the plain Gmail REST API (v1), on
// the access of the account the call acts as. A request goes straight to
// the API (google-api.ts); what a mail is in a value and on the wire is
// gmail-mail.ts.
//
// The plain API and not Google's Gmail MCP server: an attachment has to
// land in Balabash storage as a file, and only the API gives its bytes.

import { z } from 'zod';
import { CapabilityError, FileRef, capability, node, type CallContext, type Node } from '../catalog/index.ts';
import { ingestFile } from '../files/index.ts';
import { guessContentType } from '../workspace/files.ts';
import { fileRefValue } from './files.ts';
import {
  GmailMessage,
  attachmentParts,
  dateOf,
  header,
  idOf,
  messageValue,
  rawMail,
  recipients,
  type MailResource,
} from './gmail-mail.ts';
import {
  GOOGLE_AUTHORIZATION_SERVER,
  GoogleRefusal,
  googleClient,
  googleOAuth,
  orAbsent,
  type GoogleApi,
  type GoogleClient,
} from './google-api.ts';

export const GMAIL_API_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Reading (readonly) and drafts with sending (compose). Labels and the
// trash are not this node's, so gmail.modify is not asked for.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'];

const GMAIL: GoogleApi = {
  title: 'Gmail',
  forbiddenHint:
    'Check that the Gmail API is enabled in the Google Cloud project of the OAuth client and that the granted scopes include gmail.readonly and gmail.compose.',
};

// The object keys of downloaded attachments in storage start with this.
const ATTACHMENT_SCOPE = 'gmail';

// Where Gmail is: the API and the authorization server of Google, or — in a
// test — servers of the test's own.
export type GmailEndpoints = { api: string; authorizationServer: string };

const id = encodeURIComponent;

// Gmail has no object under an id: the id is unknown to it (404) or is not
// an id at all (400 "Invalid id value").
const noSuchId = (refusal: GoogleRefusal) =>
  refusal.status === 404 || (refusal.status === 400 && /invalid id value/i.test(refusal.said));

const mailbox = (ctx: CallContext) => `the mailbox of the account "${ctx.account?.account ?? ''}"`;

// A page of a list Gmail pages itself: its page token is the cursor, and a
// token it does not take is a cursor this list did not give.
async function page<T>(outcome: Promise<T>, cursor: string | undefined): Promise<T> {
  try {
    return await outcome;
  } catch (error) {
    if (cursor !== undefined && error instanceof GoogleRefusal && error.status === 400 && /page ?token/i.test(error.said)) {
      throw new CapabilityError('invalid_input', 'cursor is not a nextCursor of this list: pass the value as a result gave it.');
    }

    throw error;
  }
}

function pageToken(params: URLSearchParams, cursor: string | undefined): void {
  if (cursor === '') {
    throw new CapabilityError('invalid_input', 'cursor is empty: pass nextCursor of a result, or leave the field out.');
  }

  if (cursor !== undefined) {
    params.set('pageToken', cursor);
  }
}

// What each item of a list says when read on its own. An item that is gone
// by the time it is read — deleted in between — is not in the list.
async function present<T>(items: Array<Promise<T>>): Promise<T[]> {
  const read = await Promise.all(
    items.map(item =>
      item.catch((error: unknown) => {
        if (error instanceof GoogleRefusal && error.status === 404) {
          return null;
        }

        throw error;
      }),
    ),
  );

  return read.filter(item => item !== null);
}

const listed = (value: unknown): Array<{ id?: unknown }> => (Array.isArray(value) ? (value as Array<{ id?: unknown }>) : []);

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

// ---------------------------------------------------------------------------
// Outgoing mail

const mailFields = {
  to: z.array(z.string()).min(1).describe('Recipient addresses.'),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional().describe('Required unless the mail is a reply.'),
  body: z.string().describe('Plain text.'),
  replyToMessageId: z.string().optional().describe('The message being answered.'),
};

type MailInput = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  replyToMessageId?: string;
};

// The message resource of a draft or a send. A reply joins the conversation
// of the mail it answers: the same thread, In-Reply-To and References of
// the original, and — unless the call gives one — its subject.
async function outgoing(
  google: GoogleClient,
  at: GmailEndpoints,
  input: MailInput,
  ctx: CallContext,
): Promise<{ raw: string; threadId?: string }> {
  // What the call itself gets wrong is told before anything is asked.
  recipients(input);

  if (input.subject !== undefined && !input.subject.trim()) {
    throw new CapabilityError(
      'invalid_input',
      'subject is blank: pass the subject, or leave the field out for a reply to take the subject of the original.',
    );
  }

  let subject = input.subject ?? null;
  let inReplyTo: string | null = null;
  let references: string | null = null;
  let threadId: string | undefined;

  if (input.replyToMessageId !== undefined) {
    const original = (await orAbsent(
      google.json(
        `${at.api}/messages/${id(input.replyToMessageId)}?format=metadata` +
          '&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References',
      ),
      `There is no message "${input.replyToMessageId}" (replyToMessageId) in ${mailbox(ctx)}.`,
      noSuchId,
    )) as MailResource;
    const originalSubject = header(original.payload, 'Subject')?.trim();

    threadId = original.threadId;
    inReplyTo = header(original.payload, 'Message-ID');
    references = [header(original.payload, 'References'), inReplyTo].filter(Boolean).join(' ') || null;

    if (subject === null && originalSubject) {
      subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
    }
  }

  if (subject === null) {
    throw new CapabilityError(
      'invalid_input',
      input.replyToMessageId === undefined
        ? 'subject is required for a mail that is not a reply.'
        : `subject is required: the message "${input.replyToMessageId}" has no subject to take.`,
    );
  }

  return {
    raw: rawMail({ to: input.to, cc: input.cc, bcc: input.bcc, subject, body: input.body, inReplyTo, references }),
    ...(threadId ? { threadId } : {}),
  };
}

const draftOutput = z.strictObject({
  draftId: z.string(),
  messageId: z.string().describe("The draft's message."),
  threadId: z.string(),
});

function draftValue(draft: { id?: unknown; message?: unknown }) {
  const message = (draft.message ?? {}) as MailResource;

  return {
    draftId: idOf(draft.id, 'the draft'),
    messageId: idOf(message.id, "the draft's message"),
    threadId: idOf(message.threadId, "the draft's conversation"),
  };
}

const sentOutput = z.strictObject({ messageId: z.string(), threadId: z.string() });

function sentValue(sent: MailResource) {
  return { messageId: idOf(sent.id, 'the sent message'), threadId: idOf(sent.threadId, "the sent message's conversation") };
}

// ---------------------------------------------------------------------------
// The node

export function gmailNode(
  at: GmailEndpoints = { api: GMAIL_API_URL, authorizationServer: GOOGLE_AUTHORIZATION_SERVER },
): Node {
  const searchEmails = capability({
    name: 'search_emails',
    summary: 'Search the mailbox with Gmail query syntax and get message summaries',
    description: 'Search the mailbox with Gmail query syntax and get message summaries.',
    input: z.strictObject({
      query: z.string().describe('The syntax of the Gmail search box.'),
      limit: z.int().min(1).max(25).default(10),
      cursor: z.string().optional(),
    }),
    output: z.strictObject({
      messages: z.array(
        z.strictObject({
          messageId: z.string(),
          threadId: z.string().describe('Id of the conversation.'),
          date: z.string().nullable().describe('ISO 8601.'),
          from: z.string().nullable(),
          to: z.string().nullable(),
          subject: z.string().nullable(),
          snippet: z.string().nullable(),
          labelIds: z.array(z.string()),
        }),
      ),
      nextCursor: z.string().nullable(),
      resultSizeEstimate: z.int().nullable().describe("Gmail's estimate of all matches."),
    }),
    async run(input, ctx) {
      const google = googleClient(GMAIL, ctx);
      const params = new URLSearchParams({ q: input.query, maxResults: String(input.limit) });

      pageToken(params, input.cursor);

      const list = await page(google.json(`${at.api}/messages?${params}`), input.cursor);
      const messages = (await present(
        listed(list.messages).map(item =>
          google.json(
            `${at.api}/messages/${id(idOf(item.id, 'a found message'))}?format=metadata` +
              '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject',
          ),
        ),
      )) as MailResource[];

      return {
        messages: messages.map(message => ({
          messageId: idOf(message.id, 'a message'),
          threadId: idOf(message.threadId, 'the conversation of a message'),
          date: dateOf(message),
          from: header(message.payload, 'From'),
          to: header(message.payload, 'To'),
          subject: header(message.payload, 'Subject'),
          snippet: message.snippet ?? null,
          labelIds: message.labelIds ?? [],
        })),
        nextCursor: text(list.nextPageToken),
        resultSizeEstimate: Number.isInteger(list.resultSizeEstimate) ? (list.resultSizeEstimate as number) : null,
      };
    },
  });

  // A message read in full.
  const fullMessage = async (google: GoogleClient, messageId: string, ctx: CallContext) =>
    (await orAbsent(
      google.json(`${at.api}/messages/${id(messageId)}?format=full`),
      `There is no message "${messageId}" in ${mailbox(ctx)}.`,
      noSuchId,
    )) as MailResource;

  const getMessage = capability({
    name: 'get_message',
    summary: 'Read one message: headers, plain-text body and attachment list',
    description:
      "Read one message: its headers, its body as plain text and the list of its attachments, without their content. A draft's message reads the same way.",
    input: z.strictObject({ messageId: z.string() }),
    output: GmailMessage,
    run: async (input, ctx) => messageValue(await fullMessage(googleClient(GMAIL, ctx), input.messageId, ctx)),
  });

  const getThread = capability({
    name: 'get_thread',
    summary: 'Read a conversation: its messages with bodies and attachment lists',
    description:
      'Read a conversation: its messages with headers, plain-text bodies and attachment lists. Pages go from the newest messages to older ones.',
    input: z.strictObject({
      threadId: z.string(),
      limit: z.int().min(1).max(50).default(15),
      cursor: z.string().optional(),
    }),
    output: z.strictObject({
      messageCount: z.int().describe('All messages of the conversation.'),
      messages: z.array(GmailMessage).describe('In the order of the conversation.'),
      nextCursor: z.string().nullable(),
    }),
    async run(input, ctx) {
      // Gmail gives a conversation whole, oldest message first; the page is
      // cut here. The cursor is the id of the oldest message already given:
      // the next page is what stands before it, whatever has arrived since.
      const thread = await orAbsent(
        googleClient(GMAIL, ctx).json(`${at.api}/threads/${id(input.threadId)}?format=full`),
        `There is no conversation "${input.threadId}" in ${mailbox(ctx)}.`,
        noSuchId,
      );
      const all = listed(thread.messages) as MailResource[];
      const end = input.cursor === undefined ? all.length : all.findIndex(message => message.id === input.cursor);

      if (end === -1) {
        throw new CapabilityError(
          'invalid_input',
          `cursor is not a nextCursor of the conversation "${input.threadId}": pass the value as a result gave it, or leave the field out to start from the newest messages.`,
        );
      }

      const start = Math.max(0, end - input.limit);

      return {
        messageCount: all.length,
        messages: all.slice(start, end).map(messageValue),
        nextCursor: start > 0 ? idOf(all[start].id, 'a message') : null,
      };
    },
  });

  const getAttachment = capability({
    name: 'get_attachment',
    summary: 'Download one attachment of a message into storage',
    description: 'Download one attachment of a message into Balabash storage and get its reference.',
    input: z.strictObject({
      messageId: z.string(),
      filename: z.string().describe('As the attachment list names it.'),
      partId: z.string().optional().describe('Needed only when several attachments share the filename.'),
    }),
    output: FileRef,
    async run(input, ctx) {
      const google = googleClient(GMAIL, ctx);
      const parts = attachmentParts((await fullMessage(google, input.messageId, ctx)).payload);
      const named = parts.filter(part => part.filename === input.filename);
      const matches = input.partId === undefined ? named : named.filter(part => part.partId === input.partId);
      const there = parts.map(part => ({ filename: part.filename ?? '', partId: part.partId ?? null }));

      if (!matches.length) {
        throw new CapabilityError(
          'not_found',
          `The message "${input.messageId}" has no attachment ${JSON.stringify(input.filename)}${input.partId === undefined ? '' : ` with partId ${JSON.stringify(input.partId)}`}. ${there.length ? `Its attachments: ${there.map(part => `${JSON.stringify(part.filename)} (partId ${JSON.stringify(part.partId)})`).join(', ')}.` : 'It has no attachments.'}`,
          { attachments: there },
        );
      }

      if (matches.length > 1) {
        throw new CapabilityError(
          'invalid_input',
          `The message "${input.messageId}" has ${matches.length} attachments named ${JSON.stringify(input.filename)}: pass partId, one of ${matches.map(part => JSON.stringify(part.partId ?? null)).join(', ')}.`,
          { partIds: matches.map(part => part.partId ?? null) },
        );
      }

      const [part] = matches;
      let data = part.body?.data ?? null;

      // A message read in full carries only small attachments inline; the
      // bytes of the others come by their attachment id. The id lives as
      // long as this reading of the message, so it is never part of a value.
      if (!data && part.body?.attachmentId) {
        const attachment = await orAbsent(
          google.json(`${at.api}/messages/${id(input.messageId)}/attachments/${id(part.body.attachmentId)}`, {
            timeoutMs: 5 * 60_000,
          }),
          `The message "${input.messageId}" is no longer in ${mailbox(ctx)}.`,
        );

        data = text(attachment.data);
      }

      if (!data) {
        throw new CapabilityError(
          'external_error',
          `Gmail returned no content for the attachment ${JSON.stringify(input.filename)} of the message "${input.messageId}".`,
        );
      }

      const bytes = Buffer.from(data, 'base64url');
      const stored = await ingestFile({
        body: bytes,
        workspaceId: ctx.caller.workspaceId,
        originalFilename: input.filename,
        contentType: part.mimeType || guessContentType(input.filename),
        sizeBytes: bytes.length,
        scope: ATTACHMENT_SCOPE,
        signal: ctx.signal ?? undefined,
      }).catch((error: unknown) => {
        if (!ctx.signal?.aborted) {
          throw error;
        }

        throw new CapabilityError('unavailable', 'The call was cancelled while the attachment was being stored: nothing was stored.');
      });

      return fileRefValue(stored);
    },
  });

  const createDraft = capability({
    name: 'create_draft',
    summary: 'Create a plain-text draft: a new mail or a reply',
    description:
      'Create a plain-text draft: a new mail or a reply in an existing conversation. Nothing is sent; the user can review and edit the draft in Gmail.',
    input: z.strictObject(mailFields),
    output: draftOutput,
    async run(input, ctx) {
      const google = googleClient(GMAIL, ctx);
      const message = await outgoing(google, at, input, ctx);

      return draftValue(await google.json(`${at.api}/drafts`, { method: 'POST', json: { message } }));
    },
  });

  const listDrafts = capability({
    name: 'list_drafts',
    summary: 'List the drafts of the mailbox',
    description: 'List the drafts of the mailbox with their recipients, subjects and snippets.',
    input: z.strictObject({
      limit: z.int().min(1).max(25).default(10),
      cursor: z.string().optional(),
    }),
    output: z.strictObject({
      drafts: z.array(
        z.strictObject({
          draftId: z.string(),
          messageId: z.string().describe("The draft's message."),
          threadId: z.string(),
          to: z.string().nullable(),
          subject: z.string().nullable(),
          snippet: z.string().nullable(),
        }),
      ),
      nextCursor: z.string().nullable(),
    }),
    async run(input, ctx) {
      const google = googleClient(GMAIL, ctx);
      const params = new URLSearchParams({ maxResults: String(input.limit) });

      pageToken(params, input.cursor);

      const list = await page(google.json(`${at.api}/drafts?${params}`), input.cursor);
      const drafts = await present(
        listed(list.drafts).map(item => google.json(`${at.api}/drafts/${id(idOf(item.id, 'a draft'))}?format=metadata`)),
      );

      return {
        drafts: drafts.map(draft => {
          const message = (draft.message ?? {}) as MailResource;

          return {
            ...draftValue(draft),
            to: header(message.payload, 'To'),
            subject: header(message.payload, 'Subject'),
            snippet: message.snippet ?? null,
          };
        }),
        nextCursor: text(list.nextPageToken),
      };
    },
  });

  const updateDraft = capability({
    name: 'update_draft',
    summary: 'Replace an existing draft in full',
    description:
      'Replace an existing draft in full: recipients, subject and body are all given again, and an omitted optional field is reset.',
    input: z.strictObject({ draftId: z.string(), ...mailFields }),
    output: draftOutput,
    async run({ draftId, ...mail }, ctx) {
      const google = googleClient(GMAIL, ctx);
      const message = await outgoing(google, at, mail, ctx);

      return draftValue(
        await orAbsent(
          google.json(`${at.api}/drafts/${id(draftId)}`, { method: 'PUT', json: { message } }),
          `There is no draft "${draftId}" in ${mailbox(ctx)}.`,
          noSuchId,
        ),
      );
    },
  });

  const sendDraft = capability({
    name: 'send_draft',
    summary: 'Send an existing draft',
    description: 'Send an existing draft as it is now.',
    input: z.strictObject({ draftId: z.string() }),
    output: sentOutput,
    run: async (input, ctx) =>
      sentValue(
        await orAbsent(
          googleClient(GMAIL, ctx).json(`${at.api}/drafts/send`, { method: 'POST', json: { id: input.draftId } }),
          `There is no draft "${input.draftId}" in ${mailbox(ctx)}.`,
          noSuchId,
        ),
      ),
  });

  const sendEmail = capability({
    name: 'send_email',
    summary: 'Compose and send a plain-text mail at once: a new one or a reply',
    description: 'Compose and send a plain-text mail at once: a new mail or a reply in an existing conversation.',
    input: z.strictObject(mailFields),
    output: sentOutput,
    async run(input, ctx) {
      const google = googleClient(GMAIL, ctx);

      return sentValue(
        await google.json(`${at.api}/messages/send`, { method: 'POST', json: await outgoing(google, at, input, ctx) }),
      );
    },
  });

  return node({
    name: 'gmail',
    summary: "The user's Gmail: search and read mail, download attachments, draft and send plain-text mail.",
    connection: {
      type: 'account',
      service: 'gmail',
      summary: "Search, read and send the user's Gmail.",
      setup:
        'Each user connects their own Google account; the scopes are gmail.readonly and gmail.compose. The operator sets up once: a Google Cloud project with the Gmail API enabled and an OAuth 2.0 "Web application" client whose redirect URI is https://<balabash-domain>/oauth/callback. The same project and client serve drive. While the Google OAuth app is in Testing mode, refresh tokens expire after 7 days.',
      // Who authorized is the mailbox itself: its address tells two accounts
      // of the service apart.
      oauth: googleOAuth(at.authorizationServer, SCOPES, {
        url: `${at.api}/profile`,
        idField: 'emailAddress',
        labelField: 'emailAddress',
      }),
    },
    guide: [
      {
        text: "Sending delivers real mail from the user's address: confirm recipients, subject and body with the user before `gmail_send_email` or `gmail_send_draft`, unless they already approved them. When the user wants to look first, make a draft: it appears in their Gmail.",
      },
      {
        text: "The user can edit a draft in Gmail: before sending one you did not just write, read its current content with `gmail_get_message` by the draft's messageId.",
      },
      {
        text: 'To answer a message, pass its id as `replyToMessageId`: the reply lands in the same conversation and takes the subject of the original.',
      },
      {
        text: 'Outgoing mail is plain text only: no HTML and no attachments. Labels and the trash cannot be changed here.',
      },
    ],
    children: [searchEmails, getMessage, getThread, getAttachment, createDraft, listDrafts, updateDraft, sendDraft, sendEmail],
  });
}

export const gmail = gmailNode();
