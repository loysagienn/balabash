// A file of Google Drive as a value: the file resource of the Drive API
// (v3) turned into the type DriveFile, and what Drive knows about the types
// of Google documents — which formats each exports to, which one is its
// text. No request is made here: the node `drive` (drive.ts) asks.

import { z } from 'zod';
import { CapabilityError, namedType } from '../catalog/index.ts';

// ---------------------------------------------------------------------------
// What the Drive API answers with

type DriveUser = { displayName?: string; emailAddress?: string };

export type FileResource = {
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
  capabilities?: { canEdit?: boolean };
};

// The fields of a file resource every request asks for: what DriveFile is
// made of.
export const FILE_FIELDS =
  'id,name,mimeType,size,createdTime,modifiedTime,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),webViewLink,parents,driveId,trashed,description,shortcutDetails(targetId,targetMimeType),capabilities(canEdit)';

// ---------------------------------------------------------------------------
// Google documents and their export formats

export const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';
export const GOOGLE_SHORTCUT = 'application/vnd.google-apps.shortcut';

const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
const GOOGLE_DOCUMENT = 'application/vnd.google-apps.document';
const GOOGLE_SPREADSHEET = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_PRESENTATION = 'application/vnd.google-apps.presentation';
const GOOGLE_DRAWING = 'application/vnd.google-apps.drawing';

// A type of Google's own: a document, a folder, a shortcut, a form — a file
// without bytes of its own.
export const isGoogleType = (mimeType: string): boolean => mimeType.startsWith(GOOGLE_APPS_PREFIX);

export const EXPORT_FORMATS = {
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
} as const;

export type ExportFormat = keyof typeof EXPORT_FORMATS;

export const DriveExportFormat = namedType(
  'DriveExportFormat',
  { description: 'A format a Google document can be exported to.', use: 'any' },
  z.enum(Object.keys(EXPORT_FORMATS) as [ExportFormat, ...ExportFormat[]]),
);

// What a Google document exports to: every format of its type, the one a
// download takes when none is named, and the one its text is read in — a
// Drawing has no text.
export type Exportable = { formats: ExportFormat[]; byDefault: ExportFormat; text: 'md' | 'csv' | 'txt' | null };

const EXPORTABLE: Record<string, Exportable> = {
  [GOOGLE_DOCUMENT]: { formats: ['docx', 'pdf', 'txt', 'md', 'html', 'odt', 'rtf', 'epub'], byDefault: 'docx', text: 'md' },
  // Drive exports a Sheet as a web page only zipped, not as text/html.
  [GOOGLE_SPREADSHEET]: { formats: ['xlsx', 'pdf', 'csv', 'tsv', 'ods'], byDefault: 'xlsx', text: 'csv' },
  [GOOGLE_PRESENTATION]: { formats: ['pptx', 'pdf', 'txt', 'odp'], byDefault: 'pptx', text: 'txt' },
  [GOOGLE_DRAWING]: { formats: ['png', 'jpeg', 'svg', 'pdf'], byDefault: 'png', text: null },
};

export const exportableOf = (mimeType: string): Exportable | null => EXPORTABLE[mimeType] ?? null;

// The Google document a stored file becomes when an upload converts it.
export const CONVERT_TARGETS = {
  document: GOOGLE_DOCUMENT,
  spreadsheet: GOOGLE_SPREADSHEET,
  presentation: GOOGLE_PRESENTATION,
} as const;

// ---------------------------------------------------------------------------
// The type

export const DriveFile = namedType(
  'DriveFile',
  { description: 'One file or folder of Google Drive: metadata only.' },
  z.strictObject({
    fileId: z.string().describe('Drive id.'),
    name: z.string(),
    mimeType: z.string().describe('A Google document has a type starting with "application/vnd.google-apps.".'),
    entryKind: z.enum(['folder', 'shortcut', 'google_document', 'file']),
    sizeBytes: z.int().nullable(),
    createdTime: z.string().nullable().describe('ISO 8601.'),
    modifiedTime: z.string().nullable().describe('ISO 8601.'),
    owner: z.string().nullable().describe('The first owner, as "Name <email>".'),
    lastModifiedBy: z.string().nullable().describe('As "Name <email>".'),
    webViewLink: z.string().nullable().describe('Opens the file in the browser: the link to give the user.'),
    parentFolderId: z.string().nullable(),
    sharedDriveId: z.string().nullable().describe('null for My Drive and shared-with-me files.'),
    canEdit: z.boolean().nullable(),
    trashed: z.boolean(),
    description: z.string().nullable(),
    shortcutTargetId: z.string().nullable(),
    shortcutTargetMimeType: z.string().nullable(),
    exportFormats: z
      .array(DriveExportFormat)
      .nullable()
      .describe('null for anything but a Google Doc, Sheet, Slides or Drawing.'),
  }),
);

export type DriveFileValue = z.input<typeof DriveFile>;

// The id Drive gave an object. An answer without one cannot become a value:
// every later call addresses the object by it.
export function idOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value) {
    throw new CapabilityError('external_error', `Google Drive answered without the id of ${what}.`);
  }

  return value;
}

function person(user: DriveUser | undefined): string | null {
  if (!user) {
    return null;
  }

  return user.emailAddress
    ? user.displayName
      ? `${user.displayName} <${user.emailAddress}>`
      : user.emailAddress
    : (user.displayName ?? null);
}

// The size Drive gives as a string of digits; a Google document has none.
export function sizeOf(file: FileResource): number | null {
  const size = file.size === undefined ? NaN : Number(file.size);

  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

export function fileValue(file: FileResource): DriveFileValue {
  const mimeType = file.mimeType ?? 'application/octet-stream';

  return {
    fileId: idOf(file.id, 'a file'),
    name: file.name ?? '',
    mimeType,
    entryKind:
      mimeType === GOOGLE_FOLDER
        ? 'folder'
        : mimeType === GOOGLE_SHORTCUT
          ? 'shortcut'
          : isGoogleType(mimeType)
            ? 'google_document'
            : 'file',
    sizeBytes: sizeOf(file),
    createdTime: file.createdTime ?? null,
    modifiedTime: file.modifiedTime ?? null,
    owner: person(file.owners?.[0]),
    lastModifiedBy: person(file.lastModifyingUser),
    webViewLink: file.webViewLink ?? null,
    parentFolderId: file.parents?.[0] ?? null,
    sharedDriveId: file.driveId ?? null,
    canEdit: file.capabilities?.canEdit ?? null,
    trashed: file.trashed === true,
    description: file.description || null,
    shortcutTargetId: file.shortcutDetails?.targetId ?? null,
    shortcutTargetMimeType: file.shortcutDetails?.targetMimeType ?? null,
    exportFormats: exportableOf(mimeType)?.formats ?? null,
  };
}
