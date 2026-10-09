// A log event becomes the action { type: 'event/<event.type>', event }: the
// reducers switch on the literal strings, DevTools reads the stream of
// actions as the log itself. The union covers the typed events of the core
// (src/core/event-types.ts); an event of a type the map does not know still
// dispatches (its action falls to every reducer's default branch).

import type { Event } from '../../core/contract.ts';
import type { EventOf, EventType } from '../../core/event-types.ts';

export type EventAction = { [T in EventType]: { type: `event/${T}`; event: EventOf<T> } }[EventType];

export const EVENT_PREFIX = 'event/';

export function eventAction(event: Event): EventAction {
  return { type: `${EVENT_PREFIX}${event.type}`, event } as EventAction;
}

export function isEventAction(action: { type: string }): action is EventAction {
  return action.type.startsWith(EVENT_PREFIX);
}
