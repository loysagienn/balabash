// What an upload says (design rule 23, the texts Vladimir accepted): the
// progress of a file as "1.3 of 2.1 MiB" — the size's own unit for both —
// and a failure as a reason with or without Retry: over the limit — no
// retry can help; the connection lost and a full disk — Retry; anything
// else — "Upload failed" with Retry. Pure: the store and the screens read
// the same words.

import { UPLOAD_MAX_BYTES } from '../../../utils/file-names.ts';
import { fileSize } from '../format/index.ts';
import type { ApiFailure } from '../api/index.ts';

export type UploadError = { reason: string; retry: boolean };

export const TOO_LARGE: UploadError = { reason: 'Larger than 2 GB', retry: false };

export function isTooLarge(size: number): boolean {
  return size > UPLOAD_MAX_BYTES;
}

export function uploadError(failure: ApiFailure): UploadError {
  if (failure.code === 'too_large' || failure.status === 413) {
    return TOO_LARGE;
  }

  if (failure.code === 'network' || failure.status === 0) {
    return { reason: 'Connection lost', retry: true };
  }

  if (failure.code === 'no_space' || failure.status === 507) {
    return { reason: 'Not enough space on the server', retry: true };
  }

  return { reason: 'Upload failed', retry: true };
}

// "1.3 of 2.1 MiB": the bytes sent in the unit of the whole.
export function progressWords(loaded: number, total: number): string {
  const whole = fileSize(total);
  const unit = whole.split(' ')[1] ?? 'B';
  const divisor = unit === 'MiB' ? 1024 * 1024 : unit === 'KiB' ? 1024 : 1;
  const part = Math.min(loaded, total) / divisor;
  const shown = divisor === 1 ? String(Math.round(part)) : part < 10 ? part.toFixed(1) : String(Math.round(part));

  return `${shown} of ${whole}`;
}

// The share sent, 0–100.
export function percentOf(loaded: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 100;
}

// "Uploading 1 file…" / "Uploading 2 files…": why Send waits.
export function uploadingWords(count: number): string {
  return `Uploading ${count} ${count === 1 ? 'file' : 'files'}…`;
}

// The name a pasted image gets: the clipboard names every one "image.png";
// the minute it was pasted tells them apart ("pasted-17-08.png").
export function pastedName(type: string, at: Date): string {
  const extension = type.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');

  return `pasted-${hh}-${mm}.${extension}`;
}
