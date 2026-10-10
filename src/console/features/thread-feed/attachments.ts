// What the chip of an attachment reads (ThreadFeed's AttachmentView): the
// facts the event recorded come first; a stored file the history names by
// id alone is asked for its meta (GET /api/files/:fileId/meta, queries.ts)
// and read from it; what neither names is the word of its kind — "image",
// "file" — exactly the chip of the history before the facts were
// recorded. The chip is a link to the file whatever it reads, so a meta
// that failed to come leaves the word, not an error state (the design's
// chip has none); the query asks again at the next mount.

import type { StoredFileMeta } from '../../../api/contract.ts';
import type { Attachment } from './project.ts';

export type AttachmentFacts = { name: string; image: boolean; size: number | null };

function isImageType(contentType: string | null | undefined): boolean {
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('image/');
}

// A stored file whose name the event did not record — the meta is asked
// (a resource_link has no meta; a file named by the event needs none).
export function needsMeta(att: Attachment): boolean {
  return att.fileId !== null && att.name === null;
}

export function attachmentFacts(att: Attachment, meta: StoredFileMeta | null | undefined): AttachmentFacts {
  const image = att.image || isImageType(meta?.contentType);

  return {
    name: att.name ?? meta?.name ?? (image ? 'image' : 'file'),
    image,
    size: att.size ?? meta?.sizeBytes ?? null,
  };
}
