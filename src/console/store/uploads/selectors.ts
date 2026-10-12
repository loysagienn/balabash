import type { State } from '../types.ts';
import { isRunning } from './reducer.ts';
import type { UploadRow } from './reducer.ts';

export const selectUploads = (state: State) => state.uploads;

// The panel's headline facts: how many there are, done, failed, running,
// and the progress of the whole — bytes sent of all bytes (a failed file
// counts as nothing to wait for).
export function uploadTotals(rows: UploadRow[]) {
  const done = rows.filter(row => row.state === 'done').length;
  const failed = rows.filter(row => row.state === 'err').length;
  const running = rows.filter(isRunning).length;
  const counted = rows.filter(row => row.state !== 'err');
  const size = counted.reduce((sum, row) => sum + row.size, 0);
  const loaded = counted.reduce((sum, row) => sum + (row.state === 'done' ? row.size : row.loaded), 0);

  return { total: rows.length, done, failed, running, progress: size > 0 ? Math.min(100, Math.round((loaded / size) * 100)) : running ? 0 : 100 };
}
