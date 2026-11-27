// The node `drive`: the user's Google Drive over the plain Drive REST API
// (v3), on the access of the account the call acts as. A request goes
// straight to the API (google-api.ts); what a file is in a value is
// drive-file.ts.
//
// The plain API and not Google's Drive MCP server: a file crosses the
// border as a stored file — a download lands in Balabash storage, an upload
// reads from it — and the bytes never enter a value.
//
// The node reads and replaces what the user can read and edit (the scope
// drive, shared drives included) and adds files; it creates no folders and
// does not move, rename, share or delete.

import { Readable } from 'node:stream';
import { z } from 'zod';
import { CapabilityError, FileId, FileRef, capability, node, type CallContext, type Node } from '../catalog/index.ts';
import type { FileRef as StoredFile } from '../core/contract.ts';
import { openFileContent } from '../files/index.ts';
import { guessContentType } from '../workspace/files.ts';
import {
  CONVERT_TARGETS,
  DriveExportFormat,
  DriveFile,
  EXPORT_FORMATS,
  FILE_FIELDS,
  GOOGLE_FOLDER,
  GOOGLE_SHORTCUT,
  exportableOf,
  fileValue,
  idOf,
  isGoogleType,
  sizeOf,
  type FileResource,
} from './drive-file.ts';
import { fileRefValue, given, isTextType, storeArrival, storedFile } from './files.ts';
import {
  GOOGLE_AUTHORIZATION_SERVER,
  GoogleRefusal,
  googleClient,
  googleOAuth,
  orAbsent,
  page,
  pageToken,
  type GoogleAnswer,
  type GoogleApi,
  type GoogleClient,
} from './google-api.ts';

export const DRIVE_API_URL = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3';
// The host of Google's documents: it serves the export of a document the
// API does not give.
export const DRIVE_DOCUMENTS_URL = 'https://docs.google.com';

// Everything the user can see, readable and editable as the user can:
// drive.file would see only the files this app created, drive.readonly
// could not replace content.
const SCOPES = ['https://www.googleapis.com/auth/drive'];

const DRIVE: GoogleApi = {
  title: 'Google Drive',
  setupHint:
    'Check that the Google Drive API is enabled in the Google Cloud project of the OAuth client and that the granted scope is https://www.googleapis.com/auth/drive.',
};

// The object keys of downloaded files in storage start with this.
const DOWNLOAD_SCOPE = 'drive';

// Where Drive is: the API, its upload endpoint, the host of the documents
// and the authorization server of Google, or — in a test — servers of the
// test's own.
export type DriveEndpoints = { api: string; upload: string; documents: string; authorizationServer: string };

// The longest text `drive_get_file` returns, and the largest text file it
// reads for it.
const CONTENT_MAX_CHARS = 20_000;
const TEXT_FILE_MAX_BYTES = 2_000_000;
// The largest download, a regular file and the export of a Google document
// alike.
const DOWNLOAD_MAX_BYTES = 300_000_000;
const UPLOAD_MAX_BYTES = 150_000_000;
// An upload goes to Drive in pieces of this size, each a request of its
// own: a piece is bytes in hand, sent again when the token is renewed.
// Drive takes pieces in multiples of 256 KiB.
const PIECE_BYTES = 32 * 256 * 1024;
// What one upload lives through at the most: a setback is a request to the
// session that Drive failed — no whole answer, a 5xx — or a piece none of
// whose bytes it kept.
const MAX_SETBACKS = 3;

// The longest Drive may take over the text of a document, over the bytes of
// a download and over one piece of an upload.
const TEXT_TIMEOUT_MS = 2 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const PIECE_TIMEOUT_MS = 5 * 60_000;

// The API exports a document of 10 MB at most and refuses a larger one
// with this word.
const EXPORT_TOO_LARGE = 'exportSizeLimitExceeded';
// The longest Drive is waited for to say where the export of such a
// document is, and how often it is asked.
const OPERATION_WAIT_MS = 2 * 60_000;
const OPERATION_POLL_MS = 2_000;
// The statuses that send a request on to another address.
const REDIRECTS = [301, 302, 303, 307, 308];

const TEXT_SOURCE_TYPES = {
  plain: 'text/plain',
  markdown: 'text/markdown',
  html: 'text/html',
  csv: 'text/csv',
} as const;

const id = encodeURIComponent;

const whose = (ctx: CallContext) => `the account "${ctx.account?.account ?? ''}"`;

// An id the input names: an empty one would address the collection instead
// of an object.
function named(field: string, value: string): string {
  if (!value.trim()) {
    throw new CapabilityError('invalid_input', `${field} is empty: pass the id.`);
  }

  return value;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const listed = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

// A text of at most `limit` characters; the cut never lands inside a
// character written as a surrogate pair.
function cut(whole: string, limit: number): { text: string; truncated: boolean } {
  if (whole.length <= limit) {
    return { text: whole, truncated: false };
  }

  const last = whole.charCodeAt(limit - 1);

  return { text: whole.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit), truncated: true };
}

// The bytes of a source, as long as they keep to the limit.
async function* withinLimit(source: AsyncIterable<Uint8Array>, maxBytes: number, over: () => CapabilityError): AsyncGenerator<Buffer> {
  let size = 0;

  for await (const chunk of source) {
    size += chunk.byteLength;

    if (size > maxBytes) {
      throw over();
    }

    yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
}

function tooLargeToDownload(title: string, sizeBytes: number | null): CapabilityError {
  return new CapabilityError(
    'invalid_input',
    `${title} is ${sizeBytes === null ? 'larger than' : `${sizeBytes} bytes, over`} the ${DOWNLOAD_MAX_BYTES} bytes a download takes: nothing was stored.`,
  );
}

// A wait the cancellation of the call ends at once; what follows the wait
// sees the cancellation itself.
function pause(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);

    signal?.addEventListener('abort', done, { once: true });

    if (signal?.aborted) {
      done();
    }
  });
}

// ---------------------------------------------------------------------------
// Upload

// The content of an upload: where its bytes come from, what they are and —
// when storage knows it — how many they are.
type Content = { bytes: AsyncIterable<Uint8Array> | Iterable<Uint8Array>; contentType: string; sizeBytes: number | null };

function tooLargeToUpload(sizeBytes: number | null): CapabilityError {
  return new CapabilityError(
    'invalid_input',
    `The stored file is ${sizeBytes === null ? 'larger than' : `${sizeBytes} bytes, over`} the ${UPLOAD_MAX_BYTES} bytes an upload into Drive takes: nothing was uploaded.`,
  );
}

// What a caller is told of an upload that was given up: `undone` when the
// session cannot have finished, `unknown` when its last piece was on the
// way and Drive may have made the file of it.
type GivenUp = { undone: string; unknown: string };

const NEW_FILE: GivenUp = {
  undone: 'No file was made in Drive.',
  unknown: 'Whether Drive made the file is not known: look for it in Drive before uploading again, or there may be two.',
};

const NEW_CONTENT: GivenUp = {
  undone: 'The file keeps the content it had.',
  unknown: 'Whether the content was replaced is not known: read the file to see; replacing it again is safe.',
};

// A request to a session whose outcome Drive did not tell: no whole answer,
// or a failure of its own (5xx). The session knows what it holds.
const untold = (error: unknown): error is CapabilityError =>
  error instanceof GoogleRefusal ? error.status >= 500 : error instanceof CapabilityError && error.kind === 'unavailable';

function storedContent(file: StoredFile): Content {
  const recorded = file.contentType?.trim() || null;
  // A type that goes into a header as it is; a file stored without a
  // telling type gets the one its name gives.
  const contentType =
    recorded && recorded !== 'application/octet-stream' && /^[\x20-\x7e]+$/.test(recorded)
      ? recorded
      : guessContentType(file.originalFilename ?? '');

  async function* bytes(): AsyncGenerator<Uint8Array> {
    yield* Readable.fromWeb((await openFileContent(file.id)) as Parameters<typeof Readable.fromWeb>[0]);
  }

  return {
    bytes: withinLimit(bytes(), UPLOAD_MAX_BYTES, () => tooLargeToUpload(null)),
    contentType,
    sizeBytes: file.sizeBytes,
  };
}

// The bytes of a source cut into the pieces of an upload: every piece but
// the last is exactly `size` bytes, and the last one — the only one that
// may be empty — says that it is the last.
async function* pieces(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, size: number): AsyncGenerator<{ bytes: Buffer; last: boolean }> {
  let held: Buffer[] = [];
  let length = 0;

  for await (const chunk of source) {
    held.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    length += chunk.byteLength;

    // A piece goes out only when a byte follows it: the last piece is
    // known to be the last when it is sent.
    if (length > size) {
      let all = held.length === 1 ? held[0] : Buffer.concat(held);

      while (all.length > size) {
        yield { bytes: all.subarray(0, size), last: false };
        all = all.subarray(size);
      }

      held = [all];
      length = all.length;
    }
  }

  yield { bytes: held.length === 1 ? held[0] : Buffer.concat(held), last: true };
}

// ---------------------------------------------------------------------------
// The node

export function driveNode(
  at: DriveEndpoints = {
    api: DRIVE_API_URL,
    upload: DRIVE_UPLOAD_URL,
    documents: DRIVE_DOCUMENTS_URL,
    authorizationServer: GOOGLE_AUTHORIZATION_SERVER,
  },
): Node {
  // Every request about a file sees shared drives: without the parameter a
  // file of a shared drive is not there.
  const fileUrl = (fileId: string, params: Record<string, string>) =>
    `${at.api}/files/${id(fileId)}?${new URLSearchParams({ supportsAllDrives: 'true', ...params })}`;

  // The export of a Google document takes no such parameter.
  const exportUrl = (fileId: string, mimeType: string) => `${at.api}/files/${id(fileId)}/export?${new URLSearchParams({ mimeType })}`;

  const metadata = async (google: GoogleClient, fileId: string) =>
    (await google.json(fileUrl(fileId, { fields: FILE_FIELDS }))) as FileResource;

  // The only places the token of the account is sent to besides the API:
  // the upload endpoint, with the bytes of an upload, and the host of the
  // documents, for the export the API does not give.
  const uploadOrigin = new URL(at.upload).origin;
  const documentsOrigin = new URL(at.documents).origin;

  const noFile = (fileId: string, ctx: CallContext) => `There is no file "${fileId}" that ${whose(ctx)} can see in Google Drive.`;

  // The file a call acts on: the one its id names, or — when the id names a
  // shortcut — the target of the shortcut.
  async function target(google: GoogleClient, fileId: string, ctx: CallContext): Promise<FileResource> {
    const file = await orAbsent(metadata(google, fileId), noFile(fileId, ctx));
    const targetId = file.mimeType === GOOGLE_SHORTCUT ? file.shortcutDetails?.targetId : undefined;

    return targetId
      ? orAbsent(
          metadata(google, targetId),
          `The file "${fileId}" is a shortcut, and its target "${targetId}" is gone or is not visible to ${whose(ctx)}.`,
        )
      : file;
  }

  // One page of the files a query finds — in everything the user sees (My
  // Drive, the files shared with them and every shared drive), in the
  // user's own corpus (My Drive and the files shared with them) or in one
  // shared drive. Only the first may come incomplete: Drive does not always
  // get through every shared drive.
  function files(
    google: GoogleClient,
    params: { q: string; limit: number; cursor: string | undefined; orderBy?: string; within: 'everything' | 'user' | { sharedDriveId: string } },
  ) {
    const { within } = params;
    const search = new URLSearchParams({
      pageSize: String(params.limit),
      fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      ...(within === 'everything'
        ? { corpora: 'allDrives' }
        : within === 'user'
          ? { corpora: 'user' }
          : { corpora: 'drive', driveId: within.sharedDriveId }),
    });

    if (params.q.trim()) {
      search.set('q', params.q);
    }

    if (params.orderBy !== undefined) {
      search.set('orderBy', params.orderBy);
    }

    pageToken(search, params.cursor);

    return page(google.json(`${at.api}/files?${search}`), params.cursor);
  }

  const searchFiles = capability({
    name: 'search_files',
    summary: "Search the user's Drive with Drive query syntax and get file summaries",
    description:
      'Search My Drive, files shared with the user and shared drives with Drive query syntax. The trash is included unless the query excludes it.',
    input: z.strictObject({
      query: z.string().describe('The q syntax of the Drive files list.'),
      limit: z.int().min(1).max(50).default(20),
      cursor: z.string().optional(),
      orderBy: z.string().optional().describe('Drive sort expression. Default: relevance.'),
      sharedDriveId: z.string().optional().describe('Search only this shared drive.'),
    }),
    output: z.strictObject({
      files: z.array(DriveFile),
      nextCursor: z.string().nullable(),
      incompleteSearch: z.boolean().describe('true: Drive could not search every location, so matches may be missing.'),
    }),
    async run(input, ctx) {
      const orderBy = given('orderBy', input.orderBy);
      const sharedDriveId = given('sharedDriveId', input.sharedDriveId);
      const found = await files(googleClient(DRIVE, ctx), {
        q: input.query,
        limit: input.limit,
        cursor: input.cursor,
        orderBy,
        within: sharedDriveId === undefined ? 'everything' : { sharedDriveId },
      }).catch((error: unknown) => {
        if (error instanceof GoogleRefusal && error.status === 400) {
          // Everything the list was asked with is the call's own.
          throw new CapabilityError(
            'invalid_input',
            `Google Drive rejects the search as malformed (${error.said}): check query${orderBy === undefined ? '' : ' and orderBy'}.`,
          );
        }

        if (error instanceof GoogleRefusal && error.status === 404 && sharedDriveId !== undefined && /drive/i.test(error.said)) {
          throw new CapabilityError('not_found', `There is no shared drive "${sharedDriveId}" (sharedDriveId) among the shared drives of ${whose(ctx)}.`);
        }

        throw error;
      });

      return {
        files: listed<FileResource>(found.files).map(fileValue),
        nextCursor: text(found.nextPageToken),
        incompleteSearch: found.incompleteSearch === true,
      };
    },
  });

  const listFolder = capability({
    name: 'list_folder',
    summary: 'List the contents of a Drive folder',
    description: 'List the contents of a Drive folder, the trash excluded: subfolders first, then files, by name.',
    input: z.strictObject({
      folderId: z.string().default('root').describe('"root" is the top of My Drive; the id of a shared drive is its root.'),
      limit: z.int().min(1).max(50).default(50),
      cursor: z.string().optional(),
    }),
    output: z.strictObject({
      files: z.array(DriveFile),
      nextCursor: z.string().nullable(),
    }),
    async run(input, ctx) {
      const google = googleClient(DRIVE, ctx);
      const folderId = named('folderId', input.folderId);
      const absent = `There is no folder "${folderId}" that ${whose(ctx)} can see in Google Drive.`;
      // The folder says where its children are listed whole: in its shared
      // drive, or in the user's own corpus — "root" is the top of My Drive.
      // It also says that it is a folder: Drive lists the children of
      // anything, and a file has none.
      let within: 'user' | { sharedDriveId: string } = 'user';

      if (folderId !== 'root') {
        const folder = await orAbsent(metadata(google, folderId), absent);

        if (folder.mimeType !== GOOGLE_FOLDER) {
          throw new CapabilityError(
            'not_found',
            folder.mimeType === GOOGLE_SHORTCUT && folder.shortcutDetails?.targetId
              ? `"${folderId}" is not a folder: it is a shortcut to "${folder.shortcutDetails.targetId}".`
              : `"${folderId}" is not a folder: it is the file ${JSON.stringify(folder.name ?? '')} (${folder.mimeType ?? 'no type'}).`,
          );
        }

        within = folder.driveId ? { sharedDriveId: folder.driveId } : 'user';
      }

      const found = await orAbsent(
        files(google, {
          q: `'${folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' in parents and trashed = false`,
          limit: input.limit,
          cursor: input.cursor,
          orderBy: 'folder,name',
          within,
        }),
        absent,
      );

      // A list that may miss files is not the content of the folder.
      if (found.incompleteSearch === true) {
        throw new CapabilityError('unavailable', `Google Drive could not look through the whole folder "${folderId}" this time: nothing is listed. Try again.`);
      }

      return { files: listed<FileResource>(found.files).map(fileValue), nextCursor: text(found.nextPageToken) };
    },
  });

  const listSharedDrives = capability({
    name: 'list_shared_drives',
    summary: 'List the shared drives the user is a member of',
    description: 'List the shared drives the user is a member of.',
    input: z.strictObject({
      limit: z.int().min(1).max(100).default(100),
      cursor: z.string().optional(),
    }),
    output: z.strictObject({
      sharedDrives: z.array(
        z.strictObject({
          sharedDriveId: z.string(),
          name: z.string(),
          createdTime: z.string().nullable().describe('ISO 8601.'),
        }),
      ),
      nextCursor: z.string().nullable(),
    }),
    async run(input, ctx) {
      const search = new URLSearchParams({ pageSize: String(input.limit), fields: 'nextPageToken,drives(id,name,createdTime)' });

      pageToken(search, input.cursor);

      const found = await page(googleClient(DRIVE, ctx).json(`${at.api}/drives?${search}`), input.cursor);

      return {
        sharedDrives: listed<{ id?: unknown; name?: unknown; createdTime?: unknown }>(found.drives).map(drive => ({
          sharedDriveId: idOf(drive.id, 'a shared drive'),
          name: text(drive.name) ?? '',
          createdTime: text(drive.createdTime),
        })),
        nextCursor: text(found.nextPageToken),
      };
    },
  });

  // The text of a file: a Google document exported in the text format of
  // its type, a text file as it is. null: the file has no text form.
  async function textOf(google: GoogleClient, file: FileResource): Promise<{ text: string; format: 'md' | 'csv' | 'txt' | 'raw' } | null> {
    const fileId = idOf(file.id, 'a file');
    const mimeType = file.mimeType ?? '';
    const exportable = exportableOf(mimeType);

    if (exportable) {
      if (exportable.text === null) {
        return null;
      }

      const answer = await google.request(exportUrl(fileId, EXPORT_FORMATS[exportable.text].mimeType), {
        accept: '*/*',
        timeoutMs: TEXT_TIMEOUT_MS,
      });

      return { text: await answer.text(), format: exportable.text };
    }

    const size = sizeOf(file);

    if (isGoogleType(mimeType) || !isTextType(mimeType.split(';')[0].trim().toLowerCase()) || size === null || size > TEXT_FILE_MAX_BYTES) {
      return null;
    }

    const answer = await google.request(fileUrl(fileId, { alt: 'media' }), { accept: '*/*', timeoutMs: TEXT_TIMEOUT_MS });
    const parts: Buffer[] = [];
    let length = 0;

    for await (const chunk of answer.chunks()) {
      length += chunk.length;

      // The file grew past the limit since its size was read.
      if (length > TEXT_FILE_MAX_BYTES) {
        return null;
      }

      parts.push(chunk);
    }

    return { text: Buffer.concat(parts).toString('utf8'), format: 'raw' };
  }

  const getFile = capability({
    name: 'get_file',
    summary: 'Read one Drive file: its metadata and its text',
    description:
      'Read one Drive file: its metadata and its text, up to 20 000 characters. A Google Doc comes as Markdown, a Sheet as CSV of its first sheet only, Slides as plain text, a text file as it is. Binary files, Drawings and text files above 2 MB have no text. A shortcut is followed to its target.',
    input: z.strictObject({
      fileId: z.string(),
      includeContent: z.boolean().default(true).describe('false: metadata only.'),
    }),
    output: z.strictObject({
      file: DriveFile.describe('Of the target, when the id named a shortcut.'),
      content: z
        .string()
        .nullable()
        .describe('null when the file has no text form, is a folder, or the content was not asked for.'),
      contentFormat: z
        .enum(['md', 'csv', 'txt', 'raw'])
        .nullable()
        .describe('md: a Doc; csv: the first sheet of a Sheet; txt: Slides; raw: a text file as it is.'),
      contentTruncated: z
        .boolean()
        .describe('true: the text is longer than what was returned; `drive_download_file` gets it whole.'),
    }),
    async run(input, ctx) {
      const google = googleClient(DRIVE, ctx);
      const fileId = named('fileId', input.fileId);
      const file = await target(google, fileId, ctx);
      const read = input.includeContent && file.mimeType !== GOOGLE_FOLDER ? await orAbsent(textOf(google, file), noFile(fileId, ctx)) : null;
      const content = read ? cut(read.text, CONTENT_MAX_CHARS) : null;

      return {
        file: fileValue(file),
        content: content?.text ?? null,
        contentFormat: read?.format ?? null,
        contentTruncated: content?.truncated ?? false,
      };
    },
  });

  // The export of a Google document the API refuses as too large. Drive is
  // asked for a download of the document instead (`files.download`, an
  // operation that may take its time) and names the address of the export
  // on the host of the documents. That host takes the token and sends on
  // to an address signed for this one download, which is read without it.
  async function largeExport(google: GoogleClient, fileId: string, mimeType: string, title: string, ctx: CallContext): Promise<GoogleAnswer> {
    let operation = await google.json(`${at.api}/files/${id(fileId)}/download?${new URLSearchParams({ mimeType })}`, { method: 'POST' });
    const until = Date.now() + OPERATION_WAIT_MS;

    while (operation.done !== true) {
      const name = text(operation.name);

      if (!name) {
        throw new CapabilityError('external_error', `Google Drive started no export of ${title}: its answer names no operation to ask about.`);
      }

      if (Date.now() >= until) {
        throw new CapabilityError(
          'unavailable',
          `Google Drive did not prepare the export of ${title} within ${OPERATION_WAIT_MS / 1000} seconds: nothing was stored.`,
        );
      }

      await pause(OPERATION_POLL_MS, ctx.signal);
      operation = await google.json(`${at.api}/operations/${id(name)}`);
    }

    const failure = operation.error as { message?: unknown } | null | undefined;

    if (failure) {
      throw new CapabilityError('external_error', `Google Drive could not prepare the export of ${title}: ${text(failure.message) ?? 'it gave no reason'}`);
    }

    const address = text((operation.response as { downloadUri?: unknown } | null | undefined)?.downloadUri);

    if (!address) {
      throw new CapabilityError('external_error', `Google Drive prepared the export of ${title} and named no address to read it from.`);
    }

    if (!URL.canParse(address) || new URL(address).origin !== documentsOrigin) {
      throw new CapabilityError(
        'external_error',
        `Google Drive named an address for the export of ${title} that is not on its host of documents: nothing was asked of it.`,
      );
    }

    const first = await google.request(address, { accept: '*/*', redirect: 'manual', answers: REDIRECTS, timeoutMs: DOWNLOAD_TIMEOUT_MS });

    if (!REDIRECTS.includes(first.status)) {
      return first;
    }

    const next = first.headers.get('location');

    await first.drop();

    if (!next || !URL.canParse(next, address)) {
      throw new CapabilityError('external_error', `Google sent the export of ${title} on and named no address to go to.`);
    }

    return google.request(new URL(next, address).toString(), { accept: '*/*', unsigned: true, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  }

  const downloadFile = capability({
    name: 'download_file',
    summary: 'Download a Drive file into storage; a Google document is exported',
    description:
      "Download a Drive file into Balabash storage, up to 300 MB. A regular file comes as it is. A Google document is exported into `format`; the file's `exportFormats` name what its type supports. A shortcut is followed to its target.",
    input: z.strictObject({
      fileId: z.string(),
      format: DriveExportFormat.optional().describe(
        'Default: docx, xlsx, pptx or png, by the document type. Ignored for a regular file.',
      ),
    }),
    output: FileRef,
    async run(input, ctx) {
      const google = googleClient(DRIVE, ctx);
      const fileId = named('fileId', input.fileId);
      const file = await target(google, fileId, ctx);
      const targetId = idOf(file.id, 'a file');
      const mimeType = file.mimeType ?? '';
      const title = JSON.stringify(file.name ?? '');
      let name = file.name || targetId;
      let url: string;
      let contentType: string;
      let exported = false;

      if (mimeType === GOOGLE_FOLDER) {
        throw new CapabilityError('invalid_input', `${title} is a folder: its files are downloaded one by one.`);
      }

      if (isGoogleType(mimeType)) {
        const exportable = exportableOf(mimeType);

        if (!exportable) {
          throw new CapabilityError('invalid_input', `${title} is a Google file of the type ${mimeType}, which cannot be exported.`);
        }

        const format = input.format ?? exportable.byDefault;

        if (!exportable.formats.includes(format)) {
          throw new CapabilityError(
            'invalid_input',
            `The format "${format}" is not available for ${title} (${mimeType}): pass one of ${exportable.formats.join(', ')}.`,
            { exportFormats: exportable.formats },
          );
        }

        const { extension } = EXPORT_FORMATS[format];

        url = exportUrl(targetId, EXPORT_FORMATS[format].mimeType);
        contentType = EXPORT_FORMATS[format].mimeType;
        exported = true;
        name = name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
      } else {
        const size = sizeOf(file);

        if (size !== null && size > DOWNLOAD_MAX_BYTES) {
          throw tooLargeToDownload(title, size);
        }

        url = fileUrl(targetId, { alt: 'media' });
        contentType = mimeType || guessContentType(name);
      }

      const answer = await orAbsent(
        google.request(url, { accept: '*/*', timeoutMs: DOWNLOAD_TIMEOUT_MS }).catch((error: unknown) => {
          if (exported && error instanceof GoogleRefusal && error.reasons.includes(EXPORT_TOO_LARGE)) {
            return largeExport(google, targetId, contentType, title, ctx);
          }

          throw error;
        }),
        noFile(fileId, ctx),
      );
      const stored = await storeArrival(
        ctx.caller.workspaceId,
        Readable.from(withinLimit(answer.chunks(), DOWNLOAD_MAX_BYTES, () => tooLargeToDownload(title, null))),
        () => ({ name, contentType, scope: DOWNLOAD_SCOPE }),
        ctx.signal,
      ).catch((error: unknown) => {
        if (error instanceof CapabilityError || !ctx.signal?.aborted) {
          throw error;
        }

        throw new CapabilityError('unavailable', 'The call was cancelled while the file was being stored: nothing was stored.');
      });

      return fileRefValue(stored);
    },
  });

  // Opens a session of an upload — of a new file (POST) or of the new
  // content of an existing one (PATCH) — and gives its address. The small
  // request carries the metadata and settles the access; the bytes follow
  // to the session.
  async function openSession(
    google: GoogleClient,
    method: 'POST' | 'PATCH',
    path: string,
    fileMetadata: Record<string, unknown>,
    content: Content,
  ): Promise<string> {
    const answer = await google.request(
      `${at.upload}${path}?${new URLSearchParams({ uploadType: 'resumable', supportsAllDrives: 'true', fields: FILE_FIELDS })}`,
      {
        method,
        json: fileMetadata,
        headers: {
          'x-upload-content-type': content.contentType,
          ...(content.sizeBytes === null ? {} : { 'x-upload-content-length': String(content.sizeBytes) }),
        },
      },
    );
    const session = answer.headers.get('location');

    await answer.drop();

    if (!session) {
      throw new CapabilityError('external_error', 'Google Drive opened no session for the upload: its answer names no address to send the bytes to.');
    }

    if (!URL.canParse(session) || new URL(session).origin !== uploadOrigin) {
      throw new CapabilityError('external_error', 'Google Drive named an address for the upload that is not its upload endpoint: nothing was sent to it.');
    }

    return session;
  }

  // Sends the content to a session piece by piece and gives the file Drive
  // made of it. To every piece but the last Drive answers 308 with the
  // range it holds, and the next piece starts where that range ends — also
  // when Drive kept less than it was sent.
  //
  // A request Drive failed (no whole answer, a 5xx) is not sent blindly
  // again: the session is asked what it holds — the file, when it finished
  // meanwhile — and the upload goes on from there. Every such failure and
  // every piece Drive kept nothing of is a setback, and an upload has only
  // so many.
  async function send(google: GoogleClient, session: string, content: Content, ctx: CallContext, givenUp: GivenUp): Promise<FileResource> {
    let held = 0;
    let setbacks = 0;

    for await (const piece of pieces(content.bytes, PIECE_BYTES)) {
      let rest = piece.bytes;
      // The next request sends no bytes: it asks what the session holds.
      let asking = false;

      for (;;) {
        // The whole size is said with the last piece at the latest.
        const total = piece.last ? String(held + rest.length) : content.sizeBytes === null ? '*' : String(content.sizeBytes);
        let now: number;

        try {
          const answer = await google.request(session, {
            method: 'PUT',
            ...(asking ? {} : { body: rest }),
            headers: { 'content-range': asking || !rest.length ? `bytes */${total}` : `bytes ${held}-${held + rest.length - 1}/${total}` },
            answers: [308],
            timeoutMs: PIECE_TIMEOUT_MS,
          });

          if (answer.status !== 308) {
            return (await answer.json()) as FileResource;
          }

          // "Go on": Range names the last byte the session holds; a session
          // that holds nothing sends no Range.
          const range = /^bytes=0-(\d+)$/.exec(answer.headers.get('range') ?? '');

          now = range ? Number(range[1]) + 1 : 0;
          await answer.drop();
        } catch (error) {
          if (!untold(error) || ctx.signal?.aborted) {
            throw error;
          }

          setbacks += 1;

          if (setbacks > MAX_SETBACKS) {
            throw new CapabilityError(
              'unavailable',
              `The upload was given up: Google Drive failed it ${setbacks} times, the last one — ${error.message.replace(/\.$/, '')}. ${piece.last ? givenUp.unknown : givenUp.undone}`,
            );
          }

          asking = true;

          continue;
        }

        if (now < held || now > held + rest.length) {
          throw new CapabilityError(
            'external_error',
            `Google Drive says its upload session holds ${now} bytes, where it was sent between ${held} and ${held + rest.length}: the upload cannot go on. ${givenUp.undone}`,
          );
        }

        // Drive answered a piece and kept none of it.
        if (!asking && rest.length && now === held) {
          setbacks += 1;

          if (setbacks > MAX_SETBACKS) {
            throw new CapabilityError(
              'external_error',
              `The upload was given up: Google Drive keeps taking no bytes into its upload session, which holds ${held}. ${givenUp.undone}`,
            );
          }
        }

        asking = false;
        rest = rest.subarray(now - held);
        held = now;

        if (rest.length) {
          continue;
        }

        if (piece.last) {
          throw new CapabilityError('external_error', `Google Drive holds every byte of the upload and did not make a file of it. ${givenUp.undone}`);
        }

        break;
      }
    }

    // pieces() ends with a last piece, and a last piece ends the loop.
    throw new CapabilityError('internal', 'The upload ended without its last piece.');
  }

  const uploadFile = capability({
    name: 'upload_file',
    summary: 'Upload a stored file into Drive as a new file',
    description:
      'Upload a stored file, up to 150 MB, into Drive as a new file, optionally converting it into a Google document: a Doc from docx, txt, md or html; a Sheet from xlsx or csv; Slides from pptx.',
    input: z.strictObject({
      file: FileId,
      folderId: z.string().optional().describe('Default: the root of My Drive.'),
      name: z.string().optional().describe("Default: the stored file's name."),
      convertTo: z.enum(['document', 'spreadsheet', 'presentation']).optional(),
    }),
    output: DriveFile,
    async run(input, ctx) {
      // What the call itself gets wrong is told before anything is asked.
      const folderId = given('folderId', input.folderId);
      const name = given('name', input.name);
      const stored = await storedFile(ctx.caller, input.file);

      if (stored.sizeBytes !== null && stored.sizeBytes > UPLOAD_MAX_BYTES) {
        throw tooLargeToUpload(stored.sizeBytes);
      }

      const google = googleClient(DRIVE, ctx);
      const content = storedContent(stored);
      const session = await orAbsent(
        openSession(
          google,
          'POST',
          '/files',
          {
            name: name ?? stored.originalFilename ?? stored.id,
            ...(folderId === undefined ? {} : { parents: [folderId] }),
            ...(input.convertTo === undefined ? {} : { mimeType: CONVERT_TARGETS[input.convertTo] }),
          },
          content,
        ),
        `There is no folder "${folderId}" (folderId) that ${whose(ctx)} can see in Google Drive.`,
        refusal => refusal.status === 404 && folderId !== undefined,
      );

      return fileValue(await send(google, session, content, ctx, NEW_FILE));
    },
  });

  const updateFile = capability({
    name: 'update_file',
    summary: 'Replace the content of a Drive file with a stored file or with text',
    description:
      'Replace the content of a Drive file the user can edit, with a stored file (up to 150 MB) or with text. A Google Doc, Sheet or Slides imports the new content and keeps its id, link and sharing. Name, folder and sharing are not touched. A shortcut is followed to its target.',
    inputRules: [{ exactlyOne: ['file', 'text'] }],
    input: z.strictObject({
      fileId: z.string(),
      file: FileId.optional(),
      text: z.string().optional(),
      textFormat: z.enum(['plain', 'markdown', 'html', 'csv']).default('plain').describe('How to read `text`.'),
    }),
    output: DriveFile,
    async run(input, ctx) {
      const fileId = named('fileId', input.fileId);
      const stored = input.file === undefined ? null : await storedFile(ctx.caller, input.file);

      if (stored && stored.sizeBytes !== null && stored.sizeBytes > UPLOAD_MAX_BYTES) {
        throw tooLargeToUpload(stored.sizeBytes);
      }

      const google = googleClient(DRIVE, ctx);
      const file = await target(google, fileId, ctx);
      const targetId = idOf(file.id, 'a file');
      const title = JSON.stringify(file.name ?? '');

      if (file.mimeType === GOOGLE_FOLDER) {
        throw new CapabilityError('invalid_input', `${title} is a folder: only the content of a file can be replaced.`);
      }

      // Drive says so itself, before a byte is sent.
      if (file.capabilities?.canEdit === false) {
        throw new CapabilityError('external_error', `Google Drive gives ${whose(ctx)} no edit permission for ${title}.`);
      }

      const typed = Buffer.from(input.text ?? '', 'utf8');
      const content: Content = stored
        ? storedContent(stored)
        : { bytes: [typed], contentType: `${TEXT_SOURCE_TYPES[input.textFormat]}; charset=UTF-8`, sizeBytes: typed.length };
      // The metadata is left as it is: only the content is new.
      const session = await orAbsent(openSession(google, 'PATCH', `/files/${id(targetId)}`, {}, content), noFile(fileId, ctx));

      return fileValue(await send(google, session, content, ctx, NEW_CONTENT));
    },
  });

  return node({
    name: 'drive',
    summary: "The user's Google Drive, shared drives included: find and read files, download, upload, replace content.",
    connection: {
      type: 'account',
      service: 'drive',
      summary: "Find, read, upload and update the files of the user's Google Drive.",
      setup:
        'Each user connects their own Google account, independently of gmail; the scope is drive. The operator sets up once, in the Google Cloud project and OAuth client that serve gmail: enable the Google Drive API and add the https://www.googleapis.com/auth/drive scope on the consent screen. Google shows a client secret only when it is created; a client holds up to two secrets, so a second one can be added for this connection.',
      // Who authorized is the Google account: its address tells two accounts
      // of the service apart. The about resource wraps it in "user".
      oauth: googleOAuth(at.authorizationServer, SCOPES, {
        url: `${at.api}/about?fields=user`,
        idField: 'user.emailAddress',
        labelField: 'user.emailAddress',
      }),
    },
    guide: [
      {
        text: 'To read a document, use `drive_get_file`: it returns the text of Docs, Sheets, Slides and text files. `drive_download_file` is for the bytes: a binary file, every sheet of a spreadsheet, a particular export format.',
      },
      {
        text: 'To walk the tree, `drive_list_folder` goes one level down from any folder id; "root" is the top of My Drive, and the id of a shared drive is its root. `drive_search_files` looks through My Drive, shared files and every shared drive at once.',
      },
      { text: 'To point the user at a file that stays in Drive, give them its `webViewLink`.' },
      {
        text: "`drive_update_file` overwrites: confirm with the user first, unless they already asked for it. The previous content survives only in Drive's version history.",
      },
      { text: 'Creating folders, moving, renaming, sharing and deleting files cannot be done here.' },
      {
        text: 'To put a file of the workspace file area into Drive, store it with `export_file` and pass the id of the returned reference to `drive_upload_file` or `drive_update_file`.',
        requires: ['export_file'],
      },
    ],
    children: [searchFiles, listFolder, listSharedDrives, getFile, downloadFile, uploadFile, updateFile],
  });
}

export const drive = driveNode();
