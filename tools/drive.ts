// Google Drive capability over the Drive REST API (v3) with per-user Google
// OAuth — the gmail server's sibling: the same Google plumbing
// (google_shared.ts: a protected resource whose metadata points at
// accounts.google.com, the Balabash runtime running the OAuth flow, one
// McpServer per request bound to the request's Bearer token), the Drive API
// instead of the Gmail one. Files cross the boundary as Balabash file
// storage FileRefs: a download lands in storage, an upload reads from it —
// bytes never enter the model's context. Which is why this is not Google's
// own Drive MCP server (drivemcp.googleapis.com): its download tool answers
// the content inside the tool result.
//
// The capability reads and edits what the user can read and edit (scope
// drive, shared drives included) and adds files; it does not create folders,
// move, rename, share or delete.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toErrorResult, toStructuredResult } from '../src/capabilities/tool-result.ts';
import type { FileRef } from '../src/core/contract.ts';
import {
  GOOGLE_AUTHORIZATION_PARAMS,
  callerWorkspaceId,
  googleJson,
  googleRequest,
  serveGoogleMcp,
  type GoogleApi,
} from './google_shared.ts';

type ToolFilesApi = {
  ingest: (input: {
    body: NodeJS.ReadableStream | Buffer | Uint8Array | string;
    workspaceId?: string | null;
    originalFilename?: string | null;
    contentType?: string | null;
    sizeBytes?: number | null;
  }) => Promise<FileRef>;
  get: (fileId: string) => Promise<FileRef>;
  open: (fileId: string) => Promise<ReadableStream<Uint8Array>>;
};

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

const DRIVE_API: GoogleApi = {
  name: 'Drive API',
  forbiddenHint:
    'Check that the Google Drive API is enabled in the Google Cloud project of the OAuth client, that the granted scope is https://www.googleapis.com/auth/drive, and that this Google account can access (for edits: edit) the file.',
};

// Full Drive access: the user's own files and everything shared with them,
// readable and editable as the user can. drive.file would see only files
// this app created, drive.readonly could not edit.
const SCOPES = ['https://www.googleapis.com/auth/drive'];

const SEARCH_MAX_RESULTS_LIMIT = 50;
const CONTENT_CHAR_LIMIT = 20_000;
// Text-like blobs are read inline up to this size; larger ones are downloaded.
const INLINE_BLOB_LIMIT_BYTES = 2_000_000;
// Google exports a Workspace document at 10 MB at most; this cap is ours,
// for blobs — a file beyond it is not for the model's workbench anyway.
const DOWNLOAD_LIMIT_BYTES = 300_000_000;
// Uploads are buffered (one request with Content-Length); this bounds the buffer.
const UPLOAD_LIMIT_BYTES = 150_000_000;
// Google's multipart upload accepts up to 5 MB; bigger bodies go resumable.
const MULTIPART_LIMIT_BYTES = 5_000_000;

const FILE_FIELDS =
  'id,name,mimeType,size,createdTime,modifiedTime,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),webViewLink,parents,driveId,trashed,description,shortcutDetails(targetId,targetMimeType),capabilities(canEdit,canDownload)';
const LIST_FIELDS = `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`;

// ---------------------------------------------------------------------------
// Google Workspace document types and their export formats
// ---------------------------------------------------------------------------

const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';
const GOOGLE_SHORTCUT = 'application/vnd.google-apps.shortcut';
const GOOGLE_DOCUMENT = 'application/vnd.google-apps.document';
const GOOGLE_SPREADSHEET = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_PRESENTATION = 'application/vnd.google-apps.presentation';
const GOOGLE_DRAWING = 'application/vnd.google-apps.drawing';

type ExportFormat = { mimeType: string; extension: string };

const EXPORT_FORMATS: Record<string, ExportFormat> = {
  docx: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx' },
  xlsx: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' },
  pptx: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: 'pptx' },
  pdf: { mimeType: 'application/pdf', extension: 'pdf' },
  txt: { mimeType: 'text/plain', extension: 'txt' },
  md: { mimeType: 'text/markdown', extension: 'md' },
  html: { mimeType: 'text/html', extension: 'html' },
  csv: { mimeType: 'text/csv', extension: 'csv' },
  tsv: { mimeType: 'text/tab-separated-values', extension: 'tsv' },
  odt: { mimeType: 'application/vnd.oasis.opendocument.text', extension: 'odt' },
  ods: { mimeType: 'application/vnd.oasis.opendocument.spreadsheet', extension: 'ods' },
  odp: { mimeType: 'application/vnd.oasis.opendocument.presentation', extension: 'odp' },
  rtf: { mimeType: 'application/rtf', extension: 'rtf' },
  epub: { mimeType: 'application/epub+zip', extension: 'epub' },
  png: { mimeType: 'image/png', extension: 'png' },
  jpeg: { mimeType: 'image/jpeg', extension: 'jpg' },
  svg: { mimeType: 'image/svg+xml', extension: 'svg' },
};

const EXPORTABLE: Record<string, { formats: string[]; defaultFormat: string; textFormat: string }> = {
  [GOOGLE_DOCUMENT]: { formats: ['docx', 'pdf', 'txt', 'md', 'html', 'odt', 'rtf', 'epub'], defaultFormat: 'docx', textFormat: 'md' },
  [GOOGLE_SPREADSHEET]: { formats: ['xlsx', 'pdf', 'csv', 'tsv', 'ods', 'html'], defaultFormat: 'xlsx', textFormat: 'csv' },
  [GOOGLE_PRESENTATION]: { formats: ['pptx', 'pdf', 'txt', 'odp'], defaultFormat: 'pptx', textFormat: 'txt' },
  [GOOGLE_DRAWING]: { formats: ['png', 'jpeg', 'svg', 'pdf'], defaultFormat: 'png', textFormat: '' },
};

const CONVERT_TARGETS: Record<string, string> = {
  document: GOOGLE_DOCUMENT,
  spreadsheet: GOOGLE_SPREADSHEET,
  presentation: GOOGLE_PRESENTATION,
};

const TEXT_SOURCE_TYPES: Record<string, string> = {
  plain: 'text/plain',
  markdown: 'text/markdown',
  html: 'text/html',
  csv: 'text/csv',
};

function isGoogleAppsType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === 'string' && mimeType.startsWith(GOOGLE_APPS_PREFIX);
}

function isTextLike(mimeType: string | null | undefined): boolean {
  if (!mimeType) {
    return false;
  }

  const lower = mimeType.toLowerCase();

  return (
    lower.startsWith('text/') ||
    lower === 'application/json' ||
    lower === 'application/xml' ||
    lower === 'application/x-yaml' ||
    lower === 'application/yaml' ||
    lower === 'application/javascript' ||
    lower === 'application/x-sh' ||
    lower.endsWith('+json') ||
    lower.endsWith('+xml')
  );
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} characters]`;
}

// ---------------------------------------------------------------------------
// Drive REST helpers
// ---------------------------------------------------------------------------

type DriveUser = { displayName?: string; emailAddress?: string };

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  owners?: DriveUser[];
  lastModifyingUser?: DriveUser;
  webViewLink?: string;
  parents?: string[];
  driveId?: string;
  trashed?: boolean;
  description?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
  capabilities?: { canEdit?: boolean; canDownload?: boolean };
};

function driveUrl(path: string, params: Record<string, string | undefined> = {}, options: { allDrives?: boolean } = {}): string {
  const url = new URL(`${DRIVE_API_BASE}${path}`);

  // Every files call sees shared drives: without it a shared-drive file is
  // a 404. Not for export — the method takes no such parameter.
  if (options.allDrives !== false) {
    url.searchParams.set('supportsAllDrives', 'true');
  }

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

function uploadUrl(path: string, params: Record<string, string | undefined> = {}): string {
  const url = new URL(`${DRIVE_UPLOAD_BASE}${path}`);

  url.searchParams.set('supportsAllDrives', 'true');

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

function userLabel(user: DriveUser | undefined): string | null {
  if (!user) {
    return null;
  }

  return user.emailAddress ? (user.displayName ? `${user.displayName} <${user.emailAddress}>` : user.emailAddress) : (user.displayName ?? null);
}

// The file as the model sees it: ids and names, the kind, the size, who and
// when, the link for the user, where it lives.
function fileView(file: DriveFile): Record<string, unknown> {
  const mimeType = file.mimeType ?? null;
  const exportable = mimeType ? EXPORTABLE[mimeType] : undefined;

  return {
    file_id: file.id ?? null,
    name: file.name ?? null,
    mime_type: mimeType,
    kind: mimeType === GOOGLE_FOLDER ? 'folder' : mimeType === GOOGLE_SHORTCUT ? 'shortcut' : isGoogleAppsType(mimeType) ? 'google_document' : 'file',
    size_bytes: file.size !== undefined ? Number(file.size) : null,
    created: file.createdTime ?? null,
    modified: file.modifiedTime ?? null,
    owner: userLabel(file.owners?.[0]),
    last_modified_by: userLabel(file.lastModifyingUser),
    web_view_link: file.webViewLink ?? null,
    parent_folder_id: file.parents?.[0] ?? null,
    shared_drive_id: file.driveId ?? null,
    can_edit: file.capabilities?.canEdit ?? null,
    trashed: file.trashed ?? false,
    ...(file.description ? { description: file.description } : {}),
    ...(file.shortcutDetails?.targetId
      ? { shortcut_target_id: file.shortcutDetails.targetId, shortcut_target_mime_type: file.shortcutDetails.targetMimeType ?? null }
      : {}),
    ...(exportable ? { export_formats: exportable.formats } : {}),
  };
}

async function getFile(accessToken: string, fileId: string): Promise<DriveFile> {
  return (await googleJson(DRIVE_API, accessToken, driveUrl(`/files/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS }))) as DriveFile;
}

// A shortcut is followed to its target: the tools act on the file itself.
async function resolveFile(accessToken: string, fileId: string): Promise<DriveFile> {
  const file = await getFile(accessToken, fileId);

  if (file.mimeType === GOOGLE_SHORTCUT && file.shortcutDetails?.targetId) {
    return getFile(accessToken, file.shortcutDetails.targetId);
  }

  return file;
}

async function listFiles(
  accessToken: string,
  params: { q: string; pageSize: number; pageToken?: string | null; orderBy?: string | null; driveId?: string | null },
): Promise<{ files: DriveFile[]; nextPageToken: string | null; incompleteSearch: boolean }> {
  const result = await googleJson(
    DRIVE_API,
    accessToken,
    driveUrl('/files', {
      q: params.q,
      pageSize: String(params.pageSize),
      pageToken: params.pageToken ?? undefined,
      orderBy: params.orderBy ?? undefined,
      fields: LIST_FIELDS,
      includeItemsFromAllDrives: 'true',
      // One shared drive when named; otherwise everything the user sees —
      // My Drive, shared-with-me and every shared drive.
      ...(params.driveId ? { corpora: 'drive', driveId: params.driveId } : { corpora: 'allDrives' }),
    }),
  );

  return {
    files: Array.isArray(result.files) ? (result.files as DriveFile[]) : [],
    nextPageToken: typeof result.nextPageToken === 'string' ? result.nextPageToken : null,
    incompleteSearch: result.incompleteSearch === true,
  };
}

async function readBody(response: Response, limitBytes: number, what: string): Promise<Buffer> {
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > limitBytes) {
    throw new Error(`${what} is ${buffer.length} bytes, above the ${limitBytes}-byte limit of this tool`);
  }

  return buffer;
}

// The text of a document for the model: a Workspace document is exported
// in its text format (Docs as Markdown, Sheets as CSV of the first sheet,
// Slides as plain text), a text-like blob is read as it is. Null when the
// file has no text form — the model downloads it instead.
async function readContent(accessToken: string, file: DriveFile): Promise<{ text: string; format: string } | null> {
  const mimeType = file.mimeType ?? '';
  const exportable = EXPORTABLE[mimeType];

  if (exportable) {
    if (!exportable.textFormat) {
      return null;
    }

    const format = EXPORT_FORMATS[exportable.textFormat];
    const response = await googleRequest(
      DRIVE_API,
      accessToken,
      driveUrl(`/files/${encodeURIComponent(file.id ?? '')}/export`, { mimeType: format.mimeType }, { allDrives: false }),
      { accept: '*/*' },
    );

    return { text: await response.text(), format: exportable.textFormat };
  }

  if (isGoogleAppsType(mimeType) || !isTextLike(mimeType)) {
    return null;
  }

  const size = file.size !== undefined ? Number(file.size) : 0;

  if (size > INLINE_BLOB_LIMIT_BYTES) {
    return null;
  }

  const response = await googleRequest(
    DRIVE_API,
    accessToken,
    driveUrl(`/files/${encodeURIComponent(file.id ?? '')}`, { alt: 'media' }),
    { accept: '*/*' },
  );

  return { text: (await readBody(response, INLINE_BLOB_LIMIT_BYTES, 'The file')).toString('utf8'), format: 'raw' };
}

// Uploads bytes as a new file or as the new content of an existing one:
// multipart up to Google's 5 MB, resumable (metadata first, then one PUT of
// the body) beyond it. Answers the file resource.
async function uploadBytes(
  accessToken: string,
  target: { fileId: string | null; metadata: Record<string, unknown> },
  body: Buffer,
  contentType: string,
): Promise<DriveFile> {
  const path = target.fileId ? `/files/${encodeURIComponent(target.fileId)}` : '/files';
  const method = target.fileId ? 'PATCH' : 'POST';

  if (body.length <= MULTIPART_LIMIT_BYTES) {
    const boundary = `balabash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(target.metadata)}\r\n--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`,
        'utf8',
      ),
      body,
      Buffer.from(`\r\n--${boundary}--`, 'utf8'),
    ]);

    return (await googleJson(DRIVE_API, accessToken, uploadUrl(path, { uploadType: 'multipart', fields: FILE_FIELDS }), {
      method,
      body: multipart,
      contentType: `multipart/related; boundary=${boundary}`,
    })) as DriveFile;
  }

  const session = await googleRequest(DRIVE_API, accessToken, uploadUrl(path, { uploadType: 'resumable', fields: FILE_FIELDS }), {
    method,
    json: target.metadata,
    headers: { 'x-upload-content-type': contentType, 'x-upload-content-length': String(body.length) },
  });
  const location = session.headers.get('location');

  await session.body?.cancel().catch(() => {});

  if (!location) {
    throw new Error('Drive API started no resumable upload session (no Location header)');
  }

  return (await googleJson(DRIVE_API, accessToken, location, { method: 'PUT', body, contentType })) as DriveFile;
}

// ---------------------------------------------------------------------------
// MCP server (one instance per request, bound to that request's token)
// ---------------------------------------------------------------------------

const pageTokenShape = z.string().nullable().optional().describe('next_page_token from a previous result to fetch the next page.');

function maxResultsShape(defaultValue: number) {
  return z
    .number()
    .int()
    .min(1)
    .max(SEARCH_MAX_RESULTS_LIMIT)
    .nullable()
    .optional()
    .describe(`How many files to return, 1-${SEARCH_MAX_RESULTS_LIMIT}. Default ${defaultValue}.`);
}

function createMcpServer(accessToken: string, filesApi: ToolFilesApi): McpServer {
  const server = new McpServer({ name: 'drive', version: '1.0.0' });

  server.registerTool(
    'drive_search_files',
    {
      description:
        "Search the user's Google Drive — My Drive, files shared with them and shared drives — with Drive query syntax. Examples: name contains 'invoice' · fullText contains 'quarterly report' · mimeType = 'application/vnd.google-apps.spreadsheet' · mimeType = 'application/pdf' and modifiedTime > '2026-01-01T00:00:00' · '<folder_id>' in parents · sharedWithMe = true · trashed = false (add it to skip the trash). Combine with and/or/not; escape ' and \\ in values with a backslash. Google document types: application/vnd.google-apps.document (Docs), .spreadsheet (Sheets), .presentation (Slides), .folder. Returns file summaries (file_id, name, mime_type, kind, size, modified, owner, web_view_link, parent_folder_id). Use drive_get_file to read a file's text, drive_download_file to fetch it into storage.",
      inputSchema: {
        query: z.string().describe('Drive search query (the files.list q syntax).'),
        max_results: maxResultsShape(20),
        page_token: pageTokenShape,
        order_by: z
          .string()
          .nullable()
          .optional()
          .describe("Sort order, e.g. 'modifiedTime desc', 'name', 'createdTime desc', 'folder,name'. Default: Drive's relevance order."),
        shared_drive_id: z
          .string()
          .nullable()
          .optional()
          .describe('Restrict the search to one shared drive (its id from drive_list_shared_drives). Omit to search everything the user can see.'),
      },
    },
    async ({ query, max_results, page_token, order_by, shared_drive_id }) => {
      try {
        const result = await listFiles(accessToken, {
          q: query,
          pageSize: max_results ?? 20,
          pageToken: page_token,
          orderBy: order_by,
          driveId: shared_drive_id,
        });

        return toStructuredResult({
          query,
          incomplete_search: result.incompleteSearch,
          next_page_token: result.nextPageToken,
          files: result.files.map(fileView),
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'drive_list_folder',
    {
      description:
        "List the contents of a Drive folder (not in the trash): subfolders first, then files, by name. folder_id 'root' is the root of the user's My Drive; a shared drive's id (drive_list_shared_drives) lists that drive's root; any folder id from a listing or search goes one level down.",
      inputSchema: {
        folder_id: z.string().nullable().optional().describe("Folder id. Default 'root' — the top of My Drive."),
        max_results: maxResultsShape(50),
        page_token: pageTokenShape,
      },
    },
    async ({ folder_id, max_results, page_token }) => {
      try {
        const folder = folder_id?.trim() || 'root';
        const result = await listFiles(accessToken, {
          q: `'${folder.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' in parents and trashed = false`,
          pageSize: max_results ?? 50,
          pageToken: page_token,
          orderBy: 'folder,name',
        });

        return toStructuredResult({
          folder_id: folder,
          next_page_token: result.nextPageToken,
          files: result.files.map(fileView),
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'drive_list_shared_drives',
    {
      description: 'List the shared drives (team drives) the user is a member of: id and name. A shared drive id works as a folder_id in drive_list_folder and as shared_drive_id in drive_search_files.',
      inputSchema: {
        page_token: pageTokenShape,
      },
    },
    async ({ page_token }) => {
      try {
        const url = new URL(`${DRIVE_API_BASE}/drives`);

        url.searchParams.set('pageSize', '100');
        url.searchParams.set('fields', 'nextPageToken,drives(id,name,createdTime)');

        if (page_token) {
          url.searchParams.set('pageToken', page_token);
        }

        const result = await googleJson(DRIVE_API, accessToken, url.toString());
        const drives = Array.isArray(result.drives) ? (result.drives as Array<{ id?: string; name?: string; createdTime?: string }>) : [];

        return toStructuredResult({
          next_page_token: typeof result.nextPageToken === 'string' ? result.nextPageToken : null,
          shared_drives: drives.map(drive => ({ shared_drive_id: drive.id ?? null, name: drive.name ?? null, created: drive.createdTime ?? null })),
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'drive_get_file',
    {
      description:
        `Read one Drive file: its metadata (name, type, size, owner, modified, link, folder, can_edit, export_formats) and, by default, its text — a Google Doc as Markdown, a Google Sheet as CSV of its first sheet, Slides as plain text, a text-like file (txt, md, csv, json, …) as it is; long texts are truncated at ${CONTENT_CHAR_LIMIT} characters. Binary files (pdf, images, office files) and Sheets beyond the first sheet have no inline text: use drive_download_file. A shortcut is followed to its target.`,
      inputSchema: {
        file_id: z.string().describe('Drive file id, e.g. from drive_search_files or drive_list_folder.'),
        include_content: z
          .boolean()
          .nullable()
          .optional()
          .describe('Whether to read the text of the file along with the metadata. Default true; pass false for metadata only.'),
      },
    },
    async ({ file_id, include_content }) => {
      try {
        const file = await resolveFile(accessToken, file_id);
        const view = fileView(file);

        if (include_content === false || file.mimeType === GOOGLE_FOLDER) {
          return toStructuredResult(view);
        }

        const content = await readContent(accessToken, file);

        return toStructuredResult({
          ...view,
          content: content ? truncate(content.text, CONTENT_CHAR_LIMIT) : null,
          content_format: content?.format ?? null,
          ...(content
            ? content.format === 'csv'
              ? { content_note: 'CSV of the first sheet only; download as xlsx for every sheet.' }
              : {}
            : { content_note: 'No text form for this file type — download it with drive_download_file when the content is needed.' }),
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'drive_download_file',
    {
      description:
        'Download one Drive file into Balabash file storage and return its FileRef (id, originalFilename, contentType, sizeBytes, …). A regular file comes as it is; a Google document is exported — Docs as docx, Sheets as xlsx, Slides as pptx, Drawings as png by default, or the format you pass (see export_formats of drive_get_file; Google exports at most 10 MB). Call it only when the bytes are actually needed — drive_get_file already reads text. The returned id is a Balabash fileId: pass it to storage_get_file, send it to the user with send_file, attach it via fileIds arguments, or bring it into the workspace with workspace_import_file.',
      inputSchema: {
        file_id: z.string().describe('Drive file id.'),
        format: z
          .string()
          .nullable()
          .optional()
          .describe('Export format for a Google document: docx, xlsx, pptx, pdf, txt, md, html, csv, tsv, odt, ods, odp, rtf, epub, png, jpeg, svg — whichever the document type supports. Ignored for regular files.'),
      },
    },
    async ({ file_id, format }, extra) => {
      try {
        const file = await resolveFile(accessToken, file_id);
        const mimeType = file.mimeType ?? '';

        if (mimeType === GOOGLE_FOLDER) {
          throw new Error(`${JSON.stringify(file.name)} is a folder — list it with drive_list_folder, download its files one by one.`);
        }

        let response: Response;
        let filename = file.name ?? file_id;
        let contentType: string;

        if (isGoogleAppsType(mimeType)) {
          const exportable = EXPORTABLE[mimeType];

          if (!exportable) {
            throw new Error(`Google files of type ${mimeType} (forms, sites, maps, scripts, …) cannot be exported through the Drive API.`);
          }

          const chosen = (format ?? '').trim().toLowerCase() || exportable.defaultFormat;

          if (!exportable.formats.includes(chosen)) {
            throw new Error(`Format ${JSON.stringify(chosen)} is not available for ${mimeType}. Available: ${exportable.formats.join(', ')}.`);
          }

          const exportFormat = EXPORT_FORMATS[chosen];

          response = await googleRequest(
            DRIVE_API,
            accessToken,
            driveUrl(`/files/${encodeURIComponent(file.id ?? '')}/export`, { mimeType: exportFormat.mimeType }, { allDrives: false }),
            { accept: '*/*' },
          );
          contentType = exportFormat.mimeType;
          filename = filename.toLowerCase().endsWith(`.${exportFormat.extension}`) ? filename : `${filename}.${exportFormat.extension}`;
        } else {
          const size = file.size !== undefined ? Number(file.size) : 0;

          if (size > DOWNLOAD_LIMIT_BYTES) {
            throw new Error(`${JSON.stringify(file.name)} is ${size} bytes, above the ${DOWNLOAD_LIMIT_BYTES}-byte limit of this tool.`);
          }

          response = await googleRequest(DRIVE_API, accessToken, driveUrl(`/files/${encodeURIComponent(file.id ?? '')}`, { alt: 'media' }), {
            accept: '*/*',
          });
          contentType = response.headers.get('content-type')?.split(';')[0].trim() || mimeType || 'application/octet-stream';
        }

        const body = await readBody(response, DOWNLOAD_LIMIT_BYTES, 'The file');
        const stored = await filesApi.ingest({
          body,
          workspaceId: callerWorkspaceId(extra),
          originalFilename: filename,
          contentType,
          sizeBytes: body.length,
        });

        // The one FileRef (§9), verbatim from the files layer.
        return toStructuredResult(stored);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'drive_upload_file',
    {
      description:
        'Upload a file from Balabash file storage into Google Drive as a new file: into My Drive\'s root, or into the folder you name (a shared drive\'s folder included). Optionally convert it into a Google Doc / Sheet / Slides (from docx, txt, md, html / xlsx, csv / pptx). Returns the new file\'s metadata with its web_view_link for the user. A file from the workspace goes through workspace_export_file first.',
      inputSchema: {
        source_file_id: z.string().describe('Balabash fileId of the stored file to upload.'),
        folder_id: z.string().nullable().optional().describe('Destination folder id. Default: the root of My Drive.'),
        name: z.string().nullable().optional().describe('Name in Drive. Default: the stored file\'s original filename.'),
        convert_to: z
          .enum(['document', 'spreadsheet', 'presentation'])
          .nullable()
          .optional()
          .describe('Convert into a Google document of this type instead of storing the file as it is.'),
      },
    },
    async ({ source_file_id, folder_id, name, convert_to }) => {
      try {
        const source = await filesApi.get(source_file_id);

        if (source.sizeBytes !== null && source.sizeBytes !== undefined && source.sizeBytes > UPLOAD_LIMIT_BYTES) {
          throw new Error(`The stored file is ${source.sizeBytes} bytes, above the ${UPLOAD_LIMIT_BYTES}-byte limit of this tool.`);
        }

        const body = await readBody(new Response(await filesApi.open(source_file_id)), UPLOAD_LIMIT_BYTES, 'The stored file');
        const metadata: Record<string, unknown> = {
          name: name?.trim() || source.originalFilename || source_file_id,
          ...(folder_id?.trim() ? { parents: [folder_id.trim()] } : {}),
          ...(convert_to ? { mimeType: CONVERT_TARGETS[convert_to] } : {}),
        };
        const uploaded = await uploadBytes(accessToken, { fileId: null, metadata }, body, source.contentType || 'application/octet-stream');

        return toStructuredResult(fileView(uploaded));
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'drive_update_file',
    {
      description:
        'Replace the content of an existing Drive file the user can edit — from a file in Balabash file storage (source_file_id) or from text (text, with text_format). For a Google Doc / Sheet / Slides the new content is imported into the document (a Doc takes plain, markdown, html text or a docx; a Sheet takes csv or xlsx), so the document keeps its id, link and sharing. Name, folder and sharing are not touched. Confirm with the user before overwriting — the previous content survives only in Drive\'s version history.',
      inputSchema: {
        file_id: z.string().describe('Drive file id of the file to overwrite.'),
        source_file_id: z.string().nullable().optional().describe('Balabash fileId whose bytes become the new content. Either this or text.'),
        text: z.string().nullable().optional().describe('New content as text (UTF-8). Either this or source_file_id.'),
        text_format: z
          .enum(['plain', 'markdown', 'html', 'csv'])
          .nullable()
          .optional()
          .describe('How to read text: plain (default), markdown, html or csv — matters when the target is a Google document (import format) and for the content type of a plain file.'),
      },
    },
    async ({ file_id, source_file_id, text, text_format }) => {
      try {
        if ((source_file_id ? 1 : 0) + (typeof text === 'string' ? 1 : 0) !== 1) {
          throw new Error('Pass exactly one of source_file_id and text.');
        }

        const target = await resolveFile(accessToken, file_id);

        if (target.mimeType === GOOGLE_FOLDER) {
          throw new Error(`${JSON.stringify(target.name)} is a folder; only a file's content can be replaced.`);
        }

        if (target.capabilities?.canEdit === false) {
          throw new Error(`The user cannot edit ${JSON.stringify(target.name)} (Drive reports no edit permission).`);
        }

        let body: Buffer;
        let contentType: string;

        if (source_file_id) {
          const source = await filesApi.get(source_file_id);

          if (source.sizeBytes !== null && source.sizeBytes !== undefined && source.sizeBytes > UPLOAD_LIMIT_BYTES) {
            throw new Error(`The stored file is ${source.sizeBytes} bytes, above the ${UPLOAD_LIMIT_BYTES}-byte limit of this tool.`);
          }

          body = await readBody(new Response(await filesApi.open(source_file_id)), UPLOAD_LIMIT_BYTES, 'The stored file');
          contentType = source.contentType || 'application/octet-stream';
        } else {
          body = Buffer.from(text ?? '', 'utf8');
          contentType = `${TEXT_SOURCE_TYPES[text_format ?? 'plain']}; charset=UTF-8`;
        }

        const updated = await uploadBytes(accessToken, { fileId: target.id ?? file_id, metadata: {} }, body, contentType);

        return toStructuredResult({ updated: true, ...fileView(updated) });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  return server;
}

export async function start(ctx: { filesApi: ToolFilesApi }) {
  const endpoint = await serveGoogleMcp({
    serverName: 'drive',
    scopes: SCOPES,
    createMcpServer: accessToken => createMcpServer(accessToken, ctx.filesApi),
  });

  return {
    config: {
      transport: 'http' as const,
      url: endpoint.url,
      auth: 'user' as const,
      description:
        "Google Drive integration over the Drive REST API. Each user connects their own Google account through a one-time OAuth link — independently of gmail, the same or another Google account; until then no Drive tools are available for them. After authorization the drive_* tools can search files across My Drive, shared-with-me and shared drives with Drive query syntax, list folders and shared drives, read a file's metadata and text (Google Docs as Markdown, Sheets as CSV, text files as they are), download any file into Balabash file storage (Google documents exported as docx/xlsx/pptx/pdf/…), upload a stored file into a folder and replace the content of an existing file — each tool describes itself. Creating folders, moving, renaming, sharing and deleting are not supported. Requested Google scope: drive (the files the user can see and edit, shared drives included). Operator prerequisite (one-time, before the first authorization): the same Google Cloud project and OAuth 2.0 'Web application' client that serve gmail — enable the Google Drive API in that project, add the https://www.googleapis.com/auth/drive scope on its OAuth consent screen, and provision the client's ID and secret for this integration via request_oauth_client_credentials. Google shows a client secret only when it is created; a client holds up to two secrets, so when the first is not at hand the operator adds a second one in the Google Cloud console and enters it here — gmail keeps working on the other.",
      clientRegistration: 'manual' as const,
      scope: SCOPES.join(' '),
      // Identity probe: the platform asks Drive who authorized, right after
      // the OAuth callback — the precondition for multiple Google accounts.
      // The about resource wraps the account in "user" (a dotted path).
      identityProbe: {
        url: 'https://www.googleapis.com/drive/v3/about?fields=user',
        idField: 'user.emailAddress',
        labelField: 'user.emailAddress',
      },
      authorizationParams: GOOGLE_AUTHORIZATION_PARAMS,
    },
    close: endpoint.close,
  };
}
