// A mail of Gmail in both directions: a message of the Gmail API as the
// value a capability gives (the types GmailMessage and GmailAttachment),
// and a plain-text mail as the raw RFC 5322 message the API takes. No
// request is made here: the node `gmail` (gmail.ts) reads and sends.

import { z } from 'zod';
import { CapabilityError, namedType } from '../catalog/index.ts';

// ---------------------------------------------------------------------------
// What the Gmail API answers with

export type MailHeader = { name?: string; value?: string };

export type MailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: MailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: MailPart[];
};

export type MailResource = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: MailPart;
};

// ---------------------------------------------------------------------------
// The types

export const GmailAttachment = namedType(
  'GmailAttachment',
  { description: 'One attachment of a Gmail message: no content, only what identifies it.' },
  z.strictObject({
    filename: z.string(),
    partId: z.string().nullable().describe('Tells apart attachments that share a filename.'),
    mimeType: z.string().nullable(),
    sizeBytes: z.int().nullable(),
  }),
);

export const GmailMessage = namedType(
  'GmailMessage',
  { description: 'One Gmail message: headers, plain-text body and the list of attachments.' },
  z.strictObject({
    messageId: z.string(),
    threadId: z.string().describe('Id of the conversation.'),
    labelIds: z.array(z.string()),
    date: z.string().nullable().describe('ISO 8601.'),
    from: z.string().nullable(),
    to: z.string().nullable(),
    cc: z.string().nullable(),
    bcc: z.string().nullable().describe('Bcc header of a draft or sent message; null for incoming mail.'),
    subject: z.string().nullable(),
    rfc822MessageId: z.string().nullable().describe('The Message-ID header, not the Gmail id.'),
    body: z
      .string()
      .describe('Plain text: the text/plain parts, or the HTML converted to text; empty when the message has neither.'),
    attachments: z.array(GmailAttachment),
  }),
);

export type GmailMessageValue = z.input<typeof GmailMessage>;

// ---------------------------------------------------------------------------
// Reading

export function header(part: MailPart | undefined, name: string): string | null {
  const lower = name.toLowerCase();

  return part?.headers?.find(candidate => candidate.name?.toLowerCase() === lower)?.value ?? null;
}

// The id Gmail gave an object. An answer without one cannot become a value:
// every later call addresses the object by it.
export function idOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value) {
    throw new CapabilityError('external_error', `Gmail answered without the id of ${what}.`);
  }

  return value;
}

// The moment Gmail took the message in: its internalDate, milliseconds.
export function dateOf(message: MailResource): string | null {
  const millis = Number(message.internalDate);

  return message.internalDate && Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function decodeEntities(text: string): string {
  const codePoint = (code: number, raw: string) => (code <= 0x10ffff ? String.fromCodePoint(code) : raw);

  return text
    .replace(/&#x([0-9a-f]+);/gi, (raw, hex: string) => codePoint(parseInt(hex, 16), raw))
    .replace(/&#(\d+);/g, (raw, code: string) => codePoint(Number(code), raw))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

// The text of an HTML body: what a reader of the mail would see, without
// the markup.
function htmlToText(html: string): string {
  const text = html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The parts of a message that carry a file, in the order of the document. A
// part with a filename is an attachment whatever its type.
export function attachmentParts(part: MailPart | undefined, out: MailPart[] = []): MailPart[] {
  if (!part) {
    return out;
  }

  if (part.filename) {
    out.push(part);
  }

  for (const child of part.parts ?? []) {
    attachmentParts(child, out);
  }

  return out;
}

function textParts(part: MailPart | undefined, out: { plain: MailPart[]; html: MailPart[] }): void {
  if (!part) {
    return;
  }

  if (!part.filename && (part.body?.data || part.body?.attachmentId)) {
    const type = part.mimeType?.toLowerCase() ?? '';

    (type.startsWith('text/plain') ? out.plain : type.startsWith('text/html') ? out.html : null)?.push(part);
  }

  for (const child of part.parts ?? []) {
    textParts(child, out);
  }
}

// The parts the body of a message is read from, in the order of the
// document: its text/plain parts, or — without any — its text/html ones.
// Gmail gives the content of a part inside the message (body.data) or, for
// a large one, by reference (body.attachmentId), the way it gives an
// attachment: the node reads such a part before the message becomes a value.
export function bodyParts(payload: MailPart | undefined): { parts: MailPart[]; html: boolean } {
  const texts = { plain: [] as MailPart[], html: [] as MailPart[] };

  textParts(payload, texts);

  return texts.plain.length ? { parts: texts.plain, html: false } : { parts: texts.html, html: true };
}

function partText(part: MailPart): string {
  if (part.body?.data === undefined) {
    // A body with a part left out would pass for the whole one.
    throw new Error(`The part ${part.partId ?? '(no id)'} of the body of a message was not read.`);
  }

  return Buffer.from(part.body.data, 'base64url').toString('utf8');
}

// A message read in full (format=full), the parts of its body all read, as
// the value: the whole body, never cut.
export function messageValue(message: MailResource): GmailMessageValue {
  const { parts, html } = bodyParts(message.payload);
  const body = parts.map(partText).join('\n');
  const labelIds = message.labelIds ?? [];

  return {
    messageId: idOf(message.id, 'a message'),
    threadId: idOf(message.threadId, 'the conversation of a message'),
    labelIds,
    date: dateOf(message),
    from: header(message.payload, 'From'),
    to: header(message.payload, 'To'),
    cc: header(message.payload, 'Cc'),
    bcc: labelIds.includes('DRAFT') || labelIds.includes('SENT') ? header(message.payload, 'Bcc') : null,
    subject: header(message.payload, 'Subject'),
    rfc822MessageId: header(message.payload, 'Message-ID'),
    body: html ? htmlToText(body) : body,
    attachments: attachmentParts(message.payload).map(part => ({
      filename: part.filename ?? '',
      partId: part.partId ?? null,
      mimeType: part.mimeType ?? null,
      sizeBytes: part.body?.size ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Writing

export type Mail = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  // The Message-ID of the mail being answered, and the chain it stands in.
  inReplyTo?: string | null;
  references?: string | null;
};

const ASCII = /^[\x20-\x7e]*$/;
// A line of a header with an encoded word is at most 76 characters
// (RFC 2047): 39 bytes of text leave room for the name of the header.
const ENCODED_WORD_BYTES = 39;

// Text of a header that is not ASCII, as encoded words — as many as it
// takes, each holding whole characters, folded onto lines of their own.
function headerText(text: string): string {
  if (ASCII.test(text)) {
    return text;
  }

  const words: string[] = [];
  let word = '';

  for (const character of text) {
    if (word && Buffer.byteLength(word + character) > ENCODED_WORD_BYTES) {
      words.push(word);
      word = '';
    }

    word += character;
  }

  words.push(word);

  return words.map(part => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`).join('\r\n ');
}

// One recipient as a header takes it. A line break inside an address would
// start a header of its own, so an address with a control character is
// refused; a display name that is not ASCII ("Анна <anna@example.com>") is
// encoded, the address itself goes as it is.
function recipient(field: string, value: string): string {
  const address = value.trim();

  if (!address || /[\u0000-\u001f\u007f]/.test(address)) {
    throw new CapabilityError(
      'invalid_input',
      `${field} holds ${address ? `an address with a control character (${JSON.stringify(value)})` : 'an empty address'}: pass each recipient as "name@example.com" or "Name <name@example.com>".`,
    );
  }

  const named = /^(.*?)\s*<([^<>]+)>$/.exec(address);

  if (!named || ASCII.test(named[1])) {
    return address;
  }

  return `${headerText(named[1].replace(/^"(.*)"$/, '$1'))} <${named[2]}>`;
}

// The recipients of a mail, checked: the same check stands before any
// request is made and before the mail is written.
export function recipients(mail: Pick<Mail, 'to' | 'cc' | 'bcc'>): { to: string[]; cc: string[]; bcc: string[] } {
  return {
    to: mail.to.map(value => recipient('to', value)),
    cc: (mail.cc ?? []).map(value => recipient('cc', value)),
    bcc: (mail.bcc ?? []).map(value => recipient('bcc', value)),
  };
}

// A header value taken from another mail, on one line.
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

// The mail as the raw message the Gmail API takes: headers, then the body
// in base64 — any text goes through as it is.
export function rawMail(mail: Mail): string {
  const { to, cc, bcc } = recipients(mail);
  // One recipient per line: a long list does not make a long line.
  const list = (addresses: string[]) => addresses.join(',\r\n ');
  const headers = [`To: ${list(to)}`];

  if (cc.length) {
    headers.push(`Cc: ${list(cc)}`);
  }

  if (bcc.length) {
    headers.push(`Bcc: ${list(bcc)}`);
  }

  headers.push(`Subject: ${headerText(oneLine(mail.subject))}`);

  if (mail.inReplyTo) {
    headers.push(`In-Reply-To: ${oneLine(mail.inReplyTo)}`);
  }

  if (mail.references) {
    // One id per line: a long conversation does not make a long line.
    headers.push(`References: ${oneLine(mail.references).split(' ').join('\r\n ')}`);
  }

  headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');

  const body = Buffer.from(mail.body, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';

  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}
