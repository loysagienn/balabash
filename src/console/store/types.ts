// The store's vocabulary. Actions are objects; their types are inferred from
// the creators of every domain (store/actions.ts) plus the event actions
// (store/events.ts) — no hand-written union. A handler is a side effect keyed
// by action type (store/middleware.ts); the Api is injected so a test runs
// the real store with fake endpoints.

import type { Api } from '../lib/api/index.ts';
import type { EventAction } from './events.ts';
import type { RouterState } from './router/reducer.ts';
import type { SessionState } from './session/reducer.ts';
import type { StreamState } from './stream/reducer.ts';
import type { ThreadsState } from './threads/reducer.ts';
import type { FeedState } from './feed/reducer.ts';
import type { SessionsState } from './sessions/reducer.ts';
import type { ProjectsState } from './projects/reducer.ts';
import type { AppsState } from './apps/reducer.ts';
import type { ScheduleState } from './schedule/reducer.ts';
import type { ConnectionsState } from './connections/reducer.ts';
import type { AgentsState } from './agents/reducer.ts';
import type { UiState } from './ui/reducer.ts';

type Creators = typeof import('./actions.ts');
type CreatorAction = ReturnType<Creators[keyof Creators]>;

export type Action = CreatorAction | EventAction;
export type ActionType = Action['type'];
export type ActionOf<K extends ActionType> = Extract<Action, { type: K }>;

export type State = {
  router: RouterState;
  session: SessionState;
  stream: StreamState;
  threads: ThreadsState;
  feed: FeedState;
  sessions: SessionsState;
  projects: ProjectsState;
  apps: AppsState;
  schedule: ScheduleState;
  connections: ConnectionsState;
  agents: AgentsState;
  ui: UiState;
};

export type Dispatch = (action: Action) => void;

export type HandlerContext = {
  dispatch: Dispatch;
  getState: () => State;
  api: Api;
  // Passes the action on to the reducers; a handler calls it first.
  next: Dispatch;
};

export type ActionHandler<K extends ActionType> = (ctx: HandlerContext) => (action: ActionOf<K>) => void | Promise<void>;

export type ActionHandlers = { [K in ActionType]?: ActionHandler<K> };
