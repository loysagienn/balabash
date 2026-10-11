// The stage of a second-layer query as a card shows it (stage.ts), with
// the failure held through a retry: a refetch without data resets the
// query's error, and the card would flash its skeleton every poll
// (heldFailure). The last failure lives in a ref of the component.

import { useRef } from 'react';
import { factsStage, heldFailure } from './stage.ts';
import type { FactsStage } from './stage.ts';

export function useFactsStage<T>(query: { data: T | undefined; error: Error | null; isFetching: boolean }): FactsStage<T> {
  const held = useRef<Error | null>(null);
  const error = heldFailure(held.current, query);

  held.current = error;

  return factsStage({ data: query.data, error });
}
