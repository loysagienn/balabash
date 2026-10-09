// System (design: SystemScreen): for now the "Model usage" section's first
// card, "Main thread · tokens per request" — the prompt cache of the main
// thread per request (spec: design/main-thread-token-chart.md) over
// GET /api/llm-requests. The machine, the process, restarts, limits and the
// usage over time wait for their data (plan, "Чего нет в данных").

import { useMemo, useState } from 'react';
import { Link } from '../../lib/router/Link.tsx';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppSelector } from '../../store/hooks.ts';
import { selectMe } from '../../store/session/selectors.ts';
import { selectMainThread } from '../../store/threads/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { Card, CardBody, CardFoot, CardHead } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { Grid12, Grid12Col } from '../../ui/Grid12/Grid12.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { Seg, SegItem } from '../../ui/Seg/Seg.tsx';
import { SkelStack } from '../../ui/Skel/Skel.tsx';
import { TokenChart } from '../../ui/TokenChart/TokenChart.tsx';
import { Caption, Code } from '../../ui/atoms/atoms.tsx';
import { TOKEN_WINDOW, toTokenRequest, windowCount, windowModels, windowRange } from './SystemScreen.logic.ts';
import { useThreadRequests } from './queries.ts';
import './SystemScreen.css';

// The table shows this many rows at first and grows by as many per "Show more".
const TABLE_ROWS = 8;
const TABLE_STEP = 24;
const CLOCK_MS = 60_000;

type View = 'chart' | 'table';

function Loading() {
  return (
    <CardBody>
      <div className="sys-tok-skel" aria-busy="true">
        <SkelStack widths={[42, 100, 100, 100, 64]} />
      </div>
    </CardBody>
  );
}

export function SystemScreen() {
  const me = useAppSelector(selectMe);
  const main = useAppSelector(selectMainThread);
  const now = useNow(CLOCK_MS);
  const mainThreadId = me?.mainThreadId ?? null;
  const query = useThreadRequests(mainThreadId);
  const [view, setView] = useState<View>('chart');
  const [tableRows, setTableRows] = useState(TABLE_ROWS);
  const rows = query.data?.requests;
  const reqs = useMemo(() => (rows ?? []).map(toTokenRequest), [rows]);

  let body;

  if (mainThreadId === null) {
    body = (
      <Empty icon="message-circle" title="No main thread yet">
        The workspace has not been activated: the main thread appears with the first message to the coordinator.
      </Empty>
    );
  } else if (query.isPending) {
    body = <Loading />;
  } else if (!rows) {
    body = (
      <Empty icon="cloud-off" state="err" title="Couldn’t load the requests" action="Retry" actionIcon="refresh-cw" onAction={() => void query.refetch()}>
        {query.error?.message}
      </Empty>
    );
  } else if (rows.length === 0) {
    body = (
      <Empty icon="activity" title="No requests yet">
        The main thread has not called the model yet.
      </Empty>
    );
  } else {
    const shown = Math.min(tableRows, rows.length);

    body = (
      <>
        <p className="sys-tok-d">
          {windowCount(rows.length, TOKEN_WINDOW)} of the{' '}
          <Link className="link" route={{ key: 'thread', id: mainThreadId }}>
            main thread
          </Link>
          {main ? ` · ${main.agent}` : ''} ·{' '}
          {windowModels(rows).map((model, i) => (
            <span key={model}>
              {i > 0 ? ', ' : ''}
              <Code>{model}</Code>
            </span>
          ))}{' '}
          · {windowRange(rows[0].createdAt, rows[rows.length - 1].createdAt, now)}
        </p>
        {query.isError ? (
          <CardBody>
            <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" actionBusy={query.isFetching} onAction={() => void query.refetch()}>
              Couldn’t refresh — showing the requests loaded before. {query.error.message}
            </Note>
          </CardBody>
        ) : null}
        {view === 'chart' ? (
          <CardBody className="sys-tok-b">
            <TokenChart reqs={reqs} now={now} />
          </CardBody>
        ) : (
          <>
            <TokenChart reqs={reqs} now={now} view="table" rowsMax={shown} />
            <CardFoot>
              <Caption>
                {shown} of {rows.length} · newest first
              </Caption>
              {shown < rows.length ? (
                <button type="button" className="link sys-tok-more" onClick={() => setTableRows(shown + TABLE_STEP)}>
                  Show more
                </button>
              ) : null}
            </CardFoot>
          </>
        )}
      </>
    );
  }

  return (
    <Shell current="system" title="System">
      <Screen>
        <Grid12>
          <Grid12Col span={12} stack>
            <div className="sys-usage-h">
              <h2 className="sys-usage-t">Model usage</h2>
            </div>
            <Card narrow="bare" label="Main thread · tokens per request">
              <CardHead title="Main thread · tokens per request">
                <Seg label="View">
                  <SegItem label="Chart" sel={view === 'chart'} onClick={() => setView('chart')} />
                  <SegItem label="Table" sel={view === 'table'} onClick={() => setView('table')} />
                </Seg>
                <IconBtn icon="refresh-cw" label="Refresh" size="sm" busy={query.isFetching} disabled={mainThreadId === null} onClick={() => void query.refetch()} />
              </CardHead>
              {body}
            </Card>
          </Grid12Col>
        </Grid12>
      </Screen>
    </Shell>
  );
}
