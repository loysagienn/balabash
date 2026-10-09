// A count by place that could not be read (frontend.md, "Второй слой
// данных"): the failure in one quiet line with its own Retry, in the end
// slot of the section's or the card's header. A statistic never blocks the
// screen, and a request that failed must not look like one still loading —
// without this the number would simply be missing until the next focus or
// mount. Retry runs again only the requests that failed; nothing when none
// did. The error's words are a hover away (there is one line's room).

import type { UseQueryResult } from '@tanstack/react-query';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { ErrorLine } from '../../ui/atoms/atoms.tsx';
import { failureOf } from './totals.ts';
import './TotalFailure.css';

export function TotalFailure({ queries }: { queries: readonly Pick<UseQueryResult<unknown, Error>, 'isError' | 'error' | 'isFetching' | 'refetch'>[] }) {
  const failure = failureOf(queries);

  if (!failure) {
    return null;
  }

  return (
    <span className="ttl-fail" role="status">
      <ErrorLine>
        <span title={failure.message}>Couldn’t count</span>
      </ErrorLine>
      <Btn label="Retry" icon="refresh-cw" variant="ghost" size="sm" busy={failure.pending} onClick={failure.retry} />
    </span>
  );
}
