// The stage of a second-layer query as a card shows it (frontend.md,
// "Второй слой данных": a final failure is always visible with Retry).
// Query keeps the data of the last good answer through a failed refetch, so
// the data alone does not say the read is good: facts with a `stale` error
// are shown under a "Couldn’t refresh" note; a failure without data is the
// card's failure; neither is the skeleton.

export type FactsStage<T> = { kind: 'loading' } | { kind: 'failed'; error: Error } | { kind: 'facts'; data: T; stale: Error | null };

export function factsStage<T>(query: { data: T | undefined; error: Error | null }): FactsStage<T> {
  if (query.data !== undefined) {
    return { kind: 'facts', data: query.data, stale: query.error };
  }

  return query.error ? { kind: 'failed', error: query.error } : { kind: 'loading' };
}
