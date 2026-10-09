// createStore: the domain reducers combined, the action handlers of every
// domain in one registry (a duplicate key is a type error), the injected
// Api. Signing out resets everything but the route — the next sign-in
// starts from a fresh snapshot. The sessions domain is composed by hand:
// it folds only for threads the threads domain knows as active, so it
// runs after the others with their result in hand.

import { applyMiddleware, combineReducers, legacy_createStore as createRedux } from 'redux';
import type { Reducer, Store, StoreEnhancer } from 'redux';
import type { Api } from '../lib/api/index.ts';
import type { AppRoute } from '../lib/router/routes.ts';
import { actionHandlersMiddleware } from './middleware.ts';
import type { Action, ActionHandlers, State } from './types.ts';
import { createRouterReducer } from './router/reducer.ts';
import { routeToHandler } from './router/handlers.ts';
import { sessionReducer } from './session/reducer.ts';
import { loginDoneHandler, loginHandler, logoutHandler, sessionCheckDoneHandler, sessionCheckHandler } from './session/handlers.ts';
import { streamReducer } from './stream/reducer.ts';
import { snapshotLoadDoneHandler, snapshotLoadHandler } from './stream/handlers.ts';
import { threadsReducer } from './threads/reducer.ts';
import { loadThreadEventsHandler, loadThreadHandler, loadThreadsHandler, sendMessageHandler } from './threads/handlers.ts';
import { feedReducer } from './feed/reducer.ts';
import { sessionsReducer } from './sessions/reducer.ts';
import { projectsReducer } from './projects/reducer.ts';
import { appsReducer } from './apps/reducer.ts';
import { scheduleReducer } from './schedule/reducer.ts';
import { connectionsReducer } from './connections/reducer.ts';
import { agentsReducer } from './agents/reducer.ts';
import { uiReducer } from './ui/reducer.ts';

export type { Action, ActionOf, ActionType, State } from './types.ts';

export const handlers = {
  ROUTE_TO: routeToHandler,
  SESSION_CHECK: sessionCheckHandler,
  SESSION_CHECK_DONE: sessionCheckDoneHandler,
  LOGIN: loginHandler,
  LOGIN_DONE: loginDoneHandler,
  LOGOUT: logoutHandler,
  SNAPSHOT_LOAD: snapshotLoadHandler,
  SNAPSHOT_LOAD_DONE: snapshotLoadDoneHandler,
  LOAD_THREADS: loadThreadsHandler,
  LOAD_THREAD_EVENTS: loadThreadEventsHandler,
  LOAD_THREAD: loadThreadHandler,
  SEND_MESSAGE: sendMessageHandler,
} satisfies ActionHandlers;

export type AppStore = Store<State, Action>;

export type CreateStoreOptions = {
  api: Api;
  initialRoute: AppRoute;
  // An extra enhancer (Redux DevTools in the browser).
  enhancer?: StoreEnhancer;
};

type Domains = Omit<State, 'sessions'>;

export function createStore({ api, initialRoute, enhancer }: CreateStoreOptions): AppStore {
  const domains = combineReducers({
    router: createRouterReducer(initialRoute),
    session: sessionReducer,
    stream: streamReducer,
    threads: threadsReducer,
    feed: feedReducer,
    projects: projectsReducer,
    apps: appsReducer,
    schedule: scheduleReducer,
    connections: connectionsReducer,
    agents: agentsReducer,
    ui: uiReducer,
  }) as unknown as Reducer<Domains, Action>;

  const reduce = (state: State | undefined, action: Action): State => {
    const { sessions, ...rest } = state ?? ({} as Partial<State>);
    const nextDomains = domains(state ? (rest as Domains) : undefined, action);
    const nextSessions = sessionsReducer(sessions, action, nextDomains.threads);

    if (state && nextSessions === state.sessions && nextDomains === rest) {
      return state;
    }

    return { ...nextDomains, sessions: nextSessions };
  };

  const rootReducer = (state: State | undefined, action: Action): State => {
    if (state && (action.type === 'LOGOUT_DONE' || action.type === 'SESSION_LOST')) {
      return reduce({ router: state.router } as State, action);
    }

    return reduce(state, action);
  };

  const middleware = applyMiddleware(actionHandlersMiddleware(handlers, api));
  // The extra enhancer goes INSIDE the middleware (Redux's "devtools last"):
  // the DevTools instrument replaces the reducer with a lifted one and feeds
  // the store it builds PERFORM_ACTION wrappers, so a middleware composed
  // outside it would see only wrappers and never run a handler — with the
  // extension installed the session check would never fire.
  const enhanced: StoreEnhancer = enhancer ? (next => middleware(enhancer(next))) : middleware;

  return createRedux(rootReducer, undefined, enhanced) as AppStore;
}
