// The stream process: one EventSource per tab over GET /api/events/stream,
// opened once the session is signed in and the snapshot has stamped asOfSeq,
// closed when either goes away. Every frame becomes an event/<type> action.
// The browser reconnects by itself and sends Last-Event-ID; when it gives up
// (the server answered with an error status, e.g. a lost session), the
// process retries after a pause from the last seq it saw — the store says
// "reconnecting" the whole time the tail is not flowing; "closed" is only
// the end of a session.

import type { Store } from 'redux';
import type { Event } from '../../../core/contract.ts';
import { parseJson } from '../../../utils/serialize-json.ts';
import type { Action, State } from '../../store/types.ts';
import { eventAction } from '../../store/events.ts';
import { streamClosed, streamConnecting, streamOpened, streamReconnecting } from '../../store/stream/actions.ts';

export const STREAM_PATH = '/api/events/stream';
export const RETRY_AFTER_MS = 5_000;

export function connectStoreToStream(store: Store<State, Action>): () => void {
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const close = () => {
    if (source) {
      source.close();
      source = null;
    }

    if (retry !== null) {
      clearTimeout(retry);
      retry = null;
    }
  };

  const open = () => {
    const { stream } = store.getState();
    const after = stream.lastSeq ?? stream.asOfSeq;

    if (after === null) {
      return;
    }

    const next = new EventSource(`${STREAM_PATH}?after=${after}`);

    // Remembered before any dispatch: the dispatch notifies this very
    // process (sync), which must see the source and not open a second one.
    source = next;

    // The first opening says "connecting"; a reopening after a lost
    // connection keeps "reconnecting" until the tail flows again (onopen) —
    // the attempt is not the recovery, and the screens warn on that status.
    if (stream.status !== 'reconnecting') {
      store.dispatch(streamConnecting());
    }

    next.onopen = () => {
      if (source === next) {
        store.dispatch(streamOpened());
      }
    };

    next.onmessage = message => {
      if (source === next) {
        store.dispatch(eventAction(parseJson(message.data) as Event));
      }
    };

    next.onerror = () => {
      if (source !== next) {
        return;
      }

      if (next.readyState === EventSource.CLOSED) {
        // The browser gave up (a non-200 answer): wait, then open again.
        // The timer is set before the dispatch: the dispatch notifies this
        // very process (sync), which must see the pending retry and not
        // reopen at once.
        close();
        retry = setTimeout(() => {
          retry = null;
          sync();
        }, RETRY_AFTER_MS);
        store.dispatch(streamReconnecting());
      } else {
        store.dispatch(streamReconnecting());
      }
    };
  };

  const sync = () => {
    const { session, stream } = store.getState();
    const want = session.status === 'signed-in' && stream.asOfSeq !== null;

    if (want && !source && retry === null) {
      open();
    } else if (!want && (source || retry !== null)) {
      close();
      store.dispatch(streamClosed());
    }
  };

  sync();

  const unsubscribe = store.subscribe(sync);

  return () => {
    unsubscribe();
    close();
  };
}
