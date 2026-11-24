// The stream's `browsers` frame: the list of linked browsers this user sees
// from this workspace changed somewhere — a browser came or went, was
// paired, renamed, enabled, disabled or disconnected.
export const browsersChangedRemotely = () => ({ type: 'BROWSERS_CHANGED_REMOTELY' }) as const;
