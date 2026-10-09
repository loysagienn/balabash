import type { State } from '../types.ts';

export const selectSession = (state: State) => state.session;
export const selectMe = (state: State) => state.session.me;
export const selectSignedIn = (state: State) => state.session.status === 'signed-in';
