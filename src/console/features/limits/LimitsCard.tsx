// The "Plan limits" card (design: HomeScreen home-o2, SystemScreen — the
// "Claude limits" card of the design, one group per account now that the
// Codex plan is measured too) over GET /api/limits (queries.ts; the words —
// limits.logic.ts). A group — a header with the account and its plan, the
// account's windows as Limit rows (stacked on Home, in a row on System), a
// footer with the measurement and what the account said beside it (Claude:
// the overage, on System; Codex: credits, reset credits). Claude without a
// measurement says why (no Claude session has run, or none answered); Codex
// without one says the app-server has not answered; a round of measuring
// that brought nothing is a note with what the source said — over the rows
// of the measurement before, or in place of the rows; an account without
// plan limits says that; a Codex limit the backend is refusing requests
// against says why (a note per bucket). Home links to System ("Details"); System has a Refresh button. The
// stages of the query — factsStage: a skeleton of the rows' shape, the
// failure with Retry, the groups; a failed refetch over kept groups is a
// note above them. An answer in another shape — the server of an older
// build, until the app restarts — is a note, not a crash.

import type { ReactNode } from 'react';
import type { ClaudeLimitsResponse, CodexLimitsResponse } from '../../../api/contract.ts';
import { Link } from '../../lib/router/Link.tsx';
import { useNow } from '../../lib/format/useNow.ts';
import { factsStage } from '../../lib/query/stage.ts';
import { Card, CardBody, CardFoot, CardHead } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Limit, Limits } from '../../ui/Limit/Limit.tsx';
import { ListGroup } from '../../ui/List/List.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Caption } from '../../ui/atoms/atoms.tsx';
import type { LimitRow } from './limits.logic.ts';
import {
  NO_CODEX_LIMITS_WORDS,
  NO_CODEX_WINDOWS_WORDS,
  NO_WINDOWS_WORDS,
  OLDER_SERVER_WORDS,
  UNAVAILABLE_WORDS,
  codexMeasuredWords,
  codexReachedWords,
  codexRows,
  failureWords,
  isCurrentLimitsShape,
  limitRows,
  measuredWords,
  noLimitsWords,
  overageWords,
  planWords,
} from './limits.logic.ts';
import { useLimits } from './queries.ts';

export type LimitsCardProps = {
  // Home — the windows stacked, a link to System; system — every window in
  // a row, the overage, a Refresh button.
  scope: 'home' | 'system';
  className?: string;
};

type Scope = LimitsCardProps['scope'];

function Group({ name, plan, children }: { name: string; plan: string | null; children: ReactNode }) {
  return (
    <div className="limgrp">
      <ListGroup end={plan ?? undefined}>{name}</ListGroup>
      {children}
    </div>
  );
}

function Rows({ rows, scope, empty }: { rows: LimitRow[]; scope: Scope; empty: string }) {
  if (rows.length === 0) {
    return (
      <CardBody>
        <Note state="wait" icon="hourglass">
          {empty}
        </Note>
      </CardBody>
    );
  }

  return (
    <Limits layout={scope === 'home' ? 'stack' : undefined} narrow="tiles">
      {rows.map(row => (
        <Limit key={row.key} title={row.title} meta={row.meta} value={row.value} label={row.label} level={row.level} />
      ))}
    </Limits>
  );
}

function ClaudeGroup({ response, scope, now }: { response: ClaudeLimitsResponse; scope: Scope; now: Date }) {
  const { limits, lastFailure, liveSessions, lastSessionAt } = response;
  const failure = lastFailure ? (
    <CardBody>
      <Note state="err" icon="triangle-alert" role="status">
        {failureWords('Claude', lastFailure, now)}
      </Note>
    </CardBody>
  ) : null;

  if (limits === null) {
    return (
      <Group name="Claude" plan={null}>
        {failure ?? (
          <CardBody>
            <Note state="wait" icon="hourglass">
              {noLimitsWords({ liveSessions, lastSessionAt }, now)}
            </Note>
          </CardBody>
        )}
      </Group>
    );
  }

  const plan = planWords(limits.subscriptionType);

  if (!limits.available) {
    return (
      <Group name="Claude" plan={plan}>
        <CardBody>
          <Note icon="info">{UNAVAILABLE_WORDS}</Note>
        </CardBody>
      </Group>
    );
  }

  const overage = scope === 'system' ? overageWords(limits.overage) : null;
  const measured = measuredWords(limits, liveSessions, now);

  return (
    <Group name="Claude" plan={plan}>
      {failure}
      <Rows rows={limitRows(limits, scope === 'home' ? 'home' : 'all', now)} scope={scope} empty={NO_WINDOWS_WORDS} />
      <CardFoot>
        <Caption>{overage ? `${overage} · ${measured}` : measured}</Caption>
      </CardFoot>
    </Group>
  );
}

function CodexGroup({ response, scope, now }: { response: CodexLimitsResponse; scope: Scope; now: Date }) {
  const { limits, lastFailure } = response;
  const failure = lastFailure ? (
    <CardBody>
      <Note state="err" icon="triangle-alert" role="status">
        {failureWords('Codex', lastFailure, now)}
      </Note>
    </CardBody>
  ) : null;

  if (limits === null) {
    return (
      <Group name="Codex" plan={null}>
        {failure ?? (
          <CardBody>
            <Note state="wait" icon="hourglass">
              {NO_CODEX_LIMITS_WORDS}
            </Note>
          </CardBody>
        )}
      </Group>
    );
  }

  const reached = codexReachedWords(limits);

  return (
    <Group name="Codex" plan={planWords(limits.planType)}>
      {failure}
      {reached.length > 0 ? (
        <CardBody>
          {reached.map(note => (
            <Note key={note} state="err" icon="triangle-alert" role="status">
              {note}
            </Note>
          ))}
        </CardBody>
      ) : null}
      <Rows rows={codexRows(limits, now)} scope={scope} empty={NO_CODEX_WINDOWS_WORDS} />
      <CardFoot>
        <Caption>{codexMeasuredWords(limits, now)}</Caption>
      </CardFoot>
    </Group>
  );
}

export function LimitsCard({ scope, className }: LimitsCardProps) {
  const query = useLimits();
  const now = useNow();
  const stage = factsStage(query);
  let body;

  if (stage.kind === 'loading') {
    const skeleton = scope === 'home' ? 2 : 3;

    body = (
      <>
        {(['Claude', 'Codex'] as const).map(name => (
          <Group key={name} name={name} plan={null}>
            <Limits layout={scope === 'home' ? 'stack' : undefined} narrow="tiles">
              {Array.from({ length: name === 'Claude' ? skeleton : 1 }, (_, i) => (
                <Limit key={i} loading />
              ))}
            </Limits>
          </Group>
        ))}
      </>
    );
  } else if (stage.kind === 'failed') {
    body = (
      <Empty icon="cloud-off" state="err" title="Couldn’t load the limits" action="Retry" actionIcon="refresh-cw" onAction={() => void query.refetch()}>
        {stage.error.message}
      </Empty>
    );
  } else if (!isCurrentLimitsShape(stage.data)) {
    body = (
      <CardBody>
        <Note state="wait" icon="hourglass">
          {OLDER_SERVER_WORDS}
        </Note>
      </CardBody>
    );
  } else {
    body = (
      <>
        {stage.stale ? (
          <CardBody>
            <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" actionBusy={query.isFetching} onAction={() => void query.refetch()}>
              Couldn’t refresh — showing the limits read before. {stage.stale.message}
            </Note>
          </CardBody>
        ) : null}
        <ClaudeGroup response={stage.data.claude} scope={scope} now={now} />
        <CodexGroup response={stage.data.codex} scope={scope} now={now} />
      </>
    );
  }

  return (
    <Card narrow="bare" className={className} label="Plan limits">
      <CardHead
        title="Plan limits"
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
