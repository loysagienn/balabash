// Presence: a floating window (a Sheet, a Modal) shown under a condition —
// `<Presence>{open ? <Dialog … /> : null}</Presence>` — stays on the screen
// while it plays its way out. The owner renders what it means (the
// condition, nothing else); Presence keeps the last element while the
// condition is off until the window says it has left (the Overlay inside
// reads the context: `exiting`, and calls `onExited` when its exit
// animation ends, or at once without one). The kept element renders with
// the props it had — the window slides away saying what it said. A
// condition that comes back while the window is leaving opens a new
// window (a new key: the leaving one is cut, the new one comes in as
// any). A window rendered without a Presence around it leaves at once,
// as a plain unmount.

import { Fragment, createContext, useCallback, useContext, useState } from 'react';
import type { ReactElement } from 'react';

export type PresenceState = { exiting: boolean; onExited: () => void };

const PresenceContext = createContext<PresenceState | null>(null);

export function usePresence(): PresenceState | null {
  return useContext(PresenceContext);
}

type Slot = { element: ReactElement | null; session: number; open: boolean };

export function Presence({ children }: { children: ReactElement | null }) {
  const [slot, setSlot] = useState<Slot>({ element: children, session: 1, open: children !== null });
  const onExited = useCallback(() => setSlot(current => (current.open ? current : { ...current, element: null })), []);

  // The slot follows the condition (a state derived during render): the
  // latest element while it is on; kept, exiting, when it goes off.
  let next = slot;

  if (children !== null) {
    next = { element: children, session: slot.open ? slot.session : slot.session + 1, open: true };
  } else if (slot.open) {
    next = { ...slot, open: false };
  }

  if (next.element !== slot.element || next.open !== slot.open || next.session !== slot.session) {
    setSlot(next);
  }

  if (next.element === null) {
    return null;
  }

  return (
    <PresenceContext.Provider value={{ exiting: !next.open, onExited }}>
      <Fragment key={next.session}>{next.element}</Fragment>
    </PresenceContext.Provider>
  );
}
