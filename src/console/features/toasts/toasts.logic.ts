// How long a toast stays: a result (done, a plain message) leaves on its
// own after a few seconds; an error or something that awaits the user stays
// until closed (null).

import type { StateName } from '../../ui/atoms/state.ts';

export const TOAST_TTL_MS = 6000;

export function toastTtl(state?: StateName): number | null {
  return state === 'err' || state === 'act' ? null : TOAST_TTL_MS;
}
