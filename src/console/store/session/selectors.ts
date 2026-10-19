import type { State } from '../types.ts';

export const selectSession = (state: State) => state.session;
export const selectMe = (state: State) => state.session.me;
export const selectSignedIn = (state: State) => state.session.status === 'signed-in';
// The user of this browser's session: the id — "you" in the feed is the
// author with it — and the name for the feed and the sidebar; null while
// they have none.
export const selectUserId = (state: State) => state.session.me?.user.userId ?? null;
export const selectUserName = (state: State) => state.session.me?.user.displayName ?? null;
export const selectSettingsSaving = (state: State) => state.session.settingsSaving;
export const selectSettingsSaved = (state: State) => state.session.settingsSaved;
