// Inbound attachment resolution: the app hands us a file_uuid reference; the
// bytes live behind the claude.ai OAuth files API (the same endpoints the
// CLI uses: /api/oauth/files/{uuid}/raw). Downloaded content is ingested
// into the workspace file store so the canonical user.message carries
// ordinary fileId references — CCR specifics never leak past this adapter.

import { Readable } from 'node:stream';
import type { FileRef } from '../../core/contract.ts';
import { ingestFile } from '../../files/index.ts';
import type { InboundAttachment } from './frames.ts';

const FILES_BASE = process.env.CCR_FILES_BASE_URL ?? 'https://api.anthropic.com/api/oauth/files';

const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function guessContentType(fileName: string, isImage: boolean): string | null {
  const dot = fileName.lastIndexOf('.');
  const extension = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';

  return IMAGE_EXTENSIONS[extension] ?? (isImage ? 'image/jpeg' : null);
}

export async function downloadAttachment(
  attachment: InboundAttachment,
  accessToken: string,
  userId: string,
): Promise<FileRef> {
  const response = await fetch(`${FILES_BASE}/${encodeURIComponent(attachment.fileUuid)}/raw`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`attachment download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const sizeHeader = response.headers.get('content-length');

  return ingestFile({
    body: Readable.fromWeb(response.body as never),
    userId,
    originalFilename: attachment.fileName,
    contentType: response.headers.get('content-type') ?? guessContentType(attachment.fileName, attachment.isImage),
    sizeBytes: sizeHeader ? Number(sizeHeader) : null,
    scope: 'ccr',
  });
}
