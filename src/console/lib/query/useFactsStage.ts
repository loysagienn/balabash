// The stage of a second-layer query as a card shows it (stage.ts), with
// the failure held through a retry: a refetch without data — in flight or
// paused offline — resets the query's error, and the card would flash its
// skeleton every poll and show one for the whole time offline
// (heldFailure). The last failure lives in a ref of the component, so it
// is one query's: a component reading another key mounts anew.

import { useRef } from 'react';
import { factsStage, heldFailure } from './stage.ts';
import type { FactsStage } from './stage.ts';

export function useFactsStage<T>(query: { data: T | undefined; error: Error | null }): FactsStage<T> {
  const held = useRef<Error | null>(null);
  const error = heldFailure(held.current, query);

  held.current = error;

  return factsStage({ data: query.data, error });
}
