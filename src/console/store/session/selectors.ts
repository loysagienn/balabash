import type { State } from '../types.ts';

export const selectSession = (state: State) => state.session;
export const selectMe = (state: State) => state.session.me;
export const selectSignedIn = (state: State) => state.session.status === 'signed-in';
// The operator's name for the feed and the sidebar; null until set in Settings.
export const selectOperatorName = (state: State) => state.session.me?.operatorName ?? null;
export const selectSettingsSaving = (state: State) => state.session.settingsSaving;
