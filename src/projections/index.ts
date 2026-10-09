// Projections shared by the server (append, replay, snapshot) and the
// console (reducers, selectors): pure functions over events, node-free.

export { THREAD_TERMINAL_TYPES, threadStatusFrom, threadStartFields, threadCompletionFields } from './thread.ts';
export type { ThreadStartFields, ThreadCompletionFields } from './thread.ts';
export { feedScope, feedThreadIds } from './feed.ts';
export { pairToolCalls, groupActions } from './tool-calls.ts';
export type { ToolCallView, ToolCallStatus, ActionGroup } from './tool-calls.ts';
export { SESSION_EVENT_PREFIX, SESSION_VIEW_TYPES, foldSession, isSessionEvent, sessionStateFrom } from './session.ts';
export type { SessionState, SessionView } from './session.ts';
