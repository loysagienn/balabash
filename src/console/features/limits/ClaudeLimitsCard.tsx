// The "Claude limits" card (design: HomeScreen home-o2, SystemScreen) over
// GET /api/limits (queries.ts; the words — limits.logic.ts): the plan's
// windows as Limit rows — stacked on Home with a "Details" link to System,
// in a row on System with a Refresh button — and, under them, when the
// measurement was taken and whether a live session can refresh it; on
// System also the overage line. Without a measurement the card says why
// (no Claude session has run, or none answered); an account without plan
// limits says that. The stages of the query — factsStage: a skeleton of
// the rows' shape, the failure with Retry, the rows; a failed refetch over
// kept rows is a note above them.

import { Link } from '../../lib/router/Link.tsx';
import { useNow } from '../../lib/format/useNow.ts';
import { factsStage } from '../../lib/query/stage.ts';
import { Card, CardBody, CardFoot, CardHead } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Limit, Limits } from '../../ui/Limit/Limit.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Caption } from '../../ui/atoms/atoms.tsx';
import { NO_WINDOWS_WORDS, UNAVAILABLE_WORDS, limitRows, measuredWords, noLimitsWords, overageWords } from './limits.logic.ts';
import { useLimits } from './queries.ts';

export type ClaudeLimitsCardProps = {
  // Home — the plan-wide windows stacked, a link to System; system — every
  // window in a row, the overage, a Refresh button.
  scope: 'home' | 'system';
  className?: string;
};

export function ClaudeLimitsCard({ scope, className }: ClaudeLimitsCardProps) {
  const query = useLimits();
  const now = useNow();
  const stage = factsStage(query);
  const layout = scope === 'home' ? 'stack' : undefined;
  const skeleton = scope === 'home' ? 2 : 3;

  let body;

  if (stage.kind === 'loading') {
    body = (
      <Limits layout={layout} narrow="tiles">
        {Array.from({ length: skeleton }, (_, i) => (
          <Limit key={i} loading />
        ))}
      </Limits>
    );
  } else if (stage.kind === 'failed') {
    body = (
      <Empty icon="cloud-off" state="err" title="Couldn’t load the limits" action="Retry" actionIcon="refresh-cw" onAction={() => void query.refetch()}>
        {stage.error.message}
      </Empty>
    );
  } else {
    const { limits, liveSessions, lastSessionAt } = stage.data;
    const stale = stage.stale ? (
      <CardBody>
        <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" actionBusy={query.isFetching} onAction={() => void query.refetch()}>
          Couldn’t refresh — showing the limits read before. {stage.stale.message}
        </Note>
      </CardBody>
    ) : null;

    if (limits === null) {
      body = (
        <>
          {stale}
          <CardBody>
            <Note state="wait" icon="hourglass">
              {noLimitsWords({ liveSessions, lastSessionAt }, now)}
            </Note>
          </CardBody>
        </>
      );
    } else if (!limits.available) {
      body = (
        <>
          {stale}
          <CardBody>
            <Note icon="info">{UNAVAILABLE_WORDS}</Note>
          </CardBody>
        </>
      );
    } else {
      const rows = limitRows(limits, scope === 'home' ? 'home' : 'all', now);
      const overage = scope === 'system' ? overageWords(limits.overage) : null;

      body = (
        <>
          {stale}
          {rows.length > 0 ? (
            <Limits layout={layout} narrow="tiles">
              {rows.map(row => (
                <Limit key={row.key} title={row.title} meta={row.meta} value={row.value} label={row.label} />
              ))}
            </Limits>
          ) : (
            <CardBody>
              <Note state="wait" icon="hourglass">
                {NO_WINDOWS_WORDS}
              </Note>
            </CardBody>
          )}
          <CardFoot>
            <Caption>{overage ? `${overage} · ${measuredWords(limits, liveSessions, now)}` : measuredWords(limits, liveSessions, now)}</Caption>
          </CardFoot>
        </>
      );
    }
  }

  return (
    <Card narrow="bare" className={className} label="Claude limits">
      <CardHead
        title="Claude limits"
        link={
          scope === 'home' ? (
            <Link className="link" route={{ key: 'system' }}>
              Details
            </Link>
          ) : undefined
        }
      >
        {scope === 'system' ? <IconBtn icon="refresh-cw" label="Refresh" size="sm" busy={query.isFetching} onClick={() => void query.refetch()} /> : null}
      </CardHead>
      {body}
    </Card>
  );
}
