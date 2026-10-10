import type { State } from '../types.ts';

export const selectNotificationItems = (state: State) => state.notifications.items;
export const selectNotificationsRead = (state: State) => state.notifications.read;
