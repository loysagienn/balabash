// Action handlers as one middleware: for an action type with a handler the
// handler runs (and is responsible for calling next); every other action
// goes straight to the reducers. The handler's return value (a promise for
// async work) is returned from dispatch so a test can await it.

import type { Middleware } from 'redux';
import type { Api } from '../lib/api/index.ts';
import type { Action, ActionHandlers, ActionType, State } from './types.ts';

export const actionHandlersMiddleware =
  (handlers: ActionHandlers, api: Api): Middleware<Record<string, never>, State> =>
  ({ dispatch, getState }) =>
  next => {
    const ready = new Map<ActionType, (action: Action) => void | Promise<void>>();

    for (const [type, init] of Object.entries(handlers)) {
      if (init) {
        ready.set(
          type as ActionType,
          (init as (ctx: unknown) => (action: Action) => void | Promise<void>)({
            dispatch: (action: Action) => void dispatch(action),
            getState,
            api,
            next: (action: Action) => void next(action),
          }),
        );
      }
    }

    return action => {
      const handler = ready.get((action as Action).type);

      return handler ? handler(action as Action) : next(action);
    };
  };
