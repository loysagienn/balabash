// keys — the keys of the rows of the bell (features/notifications) the
// user has seen: one row's action pressed, or "Mark all read".
export const markNotificationsRead = (keys: string[]) => ({ type: 'NOTIFICATIONS_READ', keys }) as const;
