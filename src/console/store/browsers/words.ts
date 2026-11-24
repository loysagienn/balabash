// The toasts of the browser commands and the words they share, pure: the
// workspace as a sentence names it, why the server did not do what was
// asked, and the outcome of the switch "in this workspace", of a pairing
// and of a disconnect.

import type { ApiFailure } from '../../lib/api/index.ts';
import type { ToastInput } from '../ui/actions.ts';

// "in Personal"; a workspace without a name is "this workspace".
export function hereName(workspaceName: string | null | undefined): string {
  return workspaceName?.trim() || 'this workspace';
}

// Why a call failed, as one sentence: no answer at all, a server that is
// down behind its proxy (5xx), or a refusal with its code.
export function failureWords(failure: ApiFailure): string {
  if (failure.status === 0) {
    return 'The server didn’t answer.';
  }

  return failure.status >= 500 ? `The server didn’t answer (HTTP ${failure.status}).` : `The server refused (HTTP ${failure.status} · ${failure.code}).`;
}

export function switchedWords(name: string, on: boolean, here: string): ToastInput {
  return on
    ? { title: `${name} is on in ${here}`, desc: `Agents of ${here} can work in it now, whenever any member asks.`, state: 'done', icon: 'power' }
    : { title: `${name} is off in ${here}`, desc: `Agents of ${here} can’t use it now; their sessions in it have ended.`, state: 'done', icon: 'power-off' };
}

export function switchFailedWords(id: string, name: string, on: boolean, failure: ApiFailure): ToastInput {
  return {
    title: `Couldn’t turn ${on ? 'on' : 'off'} ${name}`,
    desc: `${failureWords(failure)} The switch is back where it was.`,
    state: 'err',
    icon: 'circle-x',
    action: { label: 'Try again', browserHere: { id, name, on } },
  };
}

export function pairedWords(name: string, here: string): ToastInput {
  return { title: `${name} is connected`, desc: `On in ${here} and online. Its limits are in the Balabash Agent icon in the toolbar.`, state: 'done', icon: 'circle-check' };
}

export function disconnectedWords(name: string): ToastInput {
  return { title: `${name} disconnected`, desc: 'It left every workspace; its sessions ended.', state: 'done', icon: 'unplug' };
}

export function disconnectFailedWords(name: string, failure: ApiFailure): ToastInput {
  return { title: `Couldn’t disconnect ${name}`, desc: `${failureWords(failure)} It stays connected.`, state: 'err', icon: 'circle-x' };
}
