// The words of the uploads to the file area (design: Upload, UploadItem,
// ClashItem; the texts Vladimir accepted): the panel's header and folded
// line, each row's status, and the clash dialog — its title, what is here
// against what is new, the names "Keep both" will give. Pure: tested
// under node:test.

import { freeNumberedName } from '../../../utils/file-names.ts';
import { fileSize, startedLabel } from '../../lib/format/index.ts';
import { percentOf, progressWords } from '../../lib/upload/words.ts';
import type { Clash, UploadRow } from '../../store/uploads/reducer.ts';
import { uploadTotals } from '../../store/uploads/selectors.ts';

export type PanelWords = { title: string; count: string; failed: string; finished: boolean; progress: number };

export function panelWords(rows: UploadRow[]): PanelWords {
  const totals = uploadTotals(rows);
  const finished = totals.running === 0;
  const failed = totals.failed > 0 ? `${totals.failed} failed` : '';

  if (finished) {
    const all = totals.done === totals.total;

    return { title: all ? 'Uploaded to' : `Uploaded ${totals.done} of ${totals.total} to`, count: `Uploaded ${totals.done} of ${totals.total}`, failed, finished, progress: 100 };
  }

  return { title: 'Uploading to', count: `Uploading ${Math.min(totals.total, totals.done + 1)} of ${totals.total}`, failed, finished, progress: totals.progress };
}

export type RowWords = { status: string; progress?: number; state?: 'done' | 'err'; retry: boolean; name: string };

export function rowWords(row: UploadRow): RowWords {
  const name = row.path ? (row.path.split('/').pop() ?? row.name) : row.name;

  switch (row.state) {
    case 'wait':
      return { name, status: 'waiting', retry: false };
    case 'up':
      return { name, status: progressWords(row.loaded, row.size), progress: percentOf(row.loaded, row.size), retry: false };
    case 'done':
      return { name, status: fileSize(row.size), state: 'done', retry: false };
    case 'err':
      return { name, status: row.error?.reason ?? 'Upload failed', state: 'err', retry: row.error?.retry ?? true };
  }
}

// "here 84 KiB · today, 16:20 — new 91 KiB": the file in the folder against
// the one being uploaded.
export function clashMeta(clash: Clash, now: Date): string {
  const fresh = `new ${fileSize(clash.size)}`;
  const there = clash.existing;

  if (!there) {
    return `already in the folder — ${fresh}`;
  }

  if (there.folder) {
    return `a folder here — ${fresh}`;
  }

  const here = [there.sizeBytes === null ? null : fileSize(there.sizeBytes), there.modifiedAt ? startedLabel(new Date(there.modifiedAt), now) : null].filter(Boolean).join(' · ');

  return `here ${here || 'a file'} — ${fresh}`;
}

export function clashTitle(clashes: Clash[]): string {
  return clashes.length === 1 ? `${clashes[0]?.name ?? 'A file'} already exists` : `${clashes.length} files already exist`;
}

// The names "Keep both" gives, as far as the folder's listing tells.
export function keptNames(clashes: Clash[], taken: Record<string, string[]>): string[] {
  const used = new Map<string, Set<string>>();

  return clashes.map(clash => {
    const names = used.get(clash.folder) ?? new Set(taken[clash.folder] ?? []);
    const name = freeNumberedName(clash.name, names);

    names.add(name);
    used.set(clash.folder, names);

    return name;
  });
}
