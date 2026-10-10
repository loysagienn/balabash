// The toasts of the connection commands, in the account's own words. Pure.

import type { ConnectionView } from '../../../api/contract.ts';
import { timeOfDay } from '../../lib/format/index.ts';
import type { ToastInput } from '../ui/actions.ts';

export function renamedWords(previous: string, connection: ConnectionView): ToastInput {
  return { title: 'Account renamed', desc: `${connection.server} “${previous}” is now “${connection.displayName}”. Its address ${connection.accountKey} stays.`, state: 'done' };
}

// The tokens are gone here; what the provider still honors is revoked on
// the provider's side — the console does not reach there.
export function disconnectedWords(connection: ConnectionView): ToastInput {
  return { title: 'Account disconnected', desc: `${connection.server} “${connection.displayName}” — its tokens are deleted here. For a full revocation, also remove Balabash in ${connection.server}’s own settings.`, state: 'off' };
}

// A link answered: it is opened from the row, lives until its expiry, and
// the row turns connected on its own when the flow completes.
export function linkReadyWords(connection: ConnectionView, expiresAt: Date): ToastInput {
  return {
    title: 'Sign-in link ready',
    desc: `Open it from the “${connection.displayName}” row — valid until ${timeOfDay(expiresAt)}. The account shows up as connected here once you finish at ${connection.server}.`,
    state: 'act',
  };
}
