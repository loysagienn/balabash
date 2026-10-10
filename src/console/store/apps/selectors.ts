import type { FormCallState } from '../../lib/forms/attempt.ts';
import type { State } from '../types.ts';
import type { AppCall } from './reducer.ts';
import { idlePublishForm, own } from './reducer.ts';

// The operator's call in flight for an app, if any (by own key: a folder
// may be named like a key of Object.prototype).
export const selectAppCall = (state: State, path: string): AppCall | null => own(state.apps.calls, path) ?? null;

// The publish dialog's form of an app in the shape every dialog attempt
// reads (lib/forms/attempt.ts): in flight while the app's call is a publish.
export const selectAppPublish = (state: State, path: string): FormCallState => {
  const form = own(state.apps.publish, path) ?? idlePublishForm;

  return { pending: own(state.apps.calls, path)?.kind === 'publish', error: form.error, done: form.done };
};
