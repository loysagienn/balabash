// The facts of a stored file as a message carries them — one vocabulary for
// the two places the log records a file by reference: the image/file block
// of an agent.message (send_file) and the files of a thread.message
// (sendToParent/sendToChild of the agent runtime). The reader — the
// console's feed — names the attachment from the event itself; history
// recorded before these facts has the fileId alone, and the reader asks
// GET /api/files/:fileId/meta for it.

import type { ContentBlock, FileRef } from './contract.ts';
import type { InboundFile } from './event-types.ts';

export type StoredFileFacts = Pick<FileRef, 'id' | 'contentType' | 'sizeBytes' | 'originalFilename'>;

export function isImageType(contentType: string | null | undefined): boolean {
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('image/');
}

// The block of an agent.message: image or file by the content type, the
// facts in the words of resource_link (name, mimeType, size) — only those
// the row knows.
export function fileContentBlock(file: StoredFileFacts): ContentBlock {
  return {
    type: isImageType(file.contentType) ? 'image' : 'file',
    fileId: file.id,
    ...(file.originalFilename ? { name: file.originalFilename } : {}),
    ...(file.contentType ? { mimeType: file.contentType } : {}),
    ...(file.sizeBytes !== null ? { size: file.sizeBytes } : {}),
  };
}

// The entry of a thread.message's files — the shape of user.message.files,
// every fact present (null when the row has none).
export function messageFile(file: StoredFileFacts): Required<InboundFile> {
  return { fileId: file.id, contentType: file.contentType, originalFilename: file.originalFilename, sizeBytes: file.sizeBytes };
}
