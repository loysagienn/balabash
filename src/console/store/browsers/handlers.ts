// The effect of the browsers domain: the owner's switch of a browser in
// this workspace (PUT or DELETE /api/browsers/:id/workspace). One call per
// browser at a time; the outcome is a toast — a refusal with "Try again",
// which sends the same command — and the list is read again either way
// (the reducer moves the stamp). An answer is applied only while the store
// still holds the switch the command went out with.

import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { pushToast } from '../ui/actions.ts';
import { setBrowserHereDone, setBrowserHereFail } from './actions.ts';
import { hereName, switchFailedWords, switchedWords } from './words.ts';

export const setBrowserHereHandler: ActionHandler<'SET_BROWSER_HERE'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    const inFlight = getState().browsers.switching[action.id];

    if (inFlight && !inFlight.settled) {
      return;
    }

    next(action);

    const call = getState().browsers.switching[action.id];

    if (!call) {
      return;
    }

    try {
      await (action.on ? api.browsers.enableHere(action.id) : api.browsers.disableHere(action.id));

      if (getState().browsers.switching[action.id] !== call) {
        return;
      }

      dispatch(setBrowserHereDone(action.id, call));
      dispatch(pushToast(switchedWords(action.name, action.on, hereName(getState().session.me?.workspaceName))));
    } catch (error) {
      if (getState().browsers.switching[action.id] !== call) {
        return;
      }

      dispatch(setBrowserHereFail(action.id, call));
      dispatch(pushToast(switchFailedWords(action.id, action.name, action.on, toApiFailure(error))));
    }
  };
