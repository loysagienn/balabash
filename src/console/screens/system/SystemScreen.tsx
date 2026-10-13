// System (design: SystemScreen): the machine — CPU per core, memory, disk
// and what uses it, traffic — the Balabash process, the restarts and the
// system event log, the "Plan limits" card (features/limits, GET
// /api/limits) and the "Model usage" section's card "Main thread · tokens
// per request" (spec: design/main-thread-token-chart.md, GET
// /api/llm-requests). The machine and the process are a measurement read
// by place every SYSTEM_REFRESH_MS (features/system/queries.ts, GET
// /api/system; the words — facts.logic.ts); the restarts and the log are
// the store's system domain — the snapshot's system events and the tail
// (store/system). The usage over time waits for its data (backlog.md).

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { SystemResponse } from '../../../api/contract.ts';
import { ApiError } from '../../lib/api/index.ts';
import { Link, useLinkTargets } from '../../lib/router/Link.tsx';
import { dateTimeLabel } from '../../lib/format/index.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { useFactsStage } from '../../lib/query/useFactsStage.ts';
import { useAppSelector } from '../../store/hooks.ts';
import { selectMe } from '../../store/session/selectors.ts';
import { selectMainThread } from '../../store/threads/selectors.ts';
import { selectSystemLog } from '../../store/system/selectors.ts';
import { LimitsCard } from '../../features/limits/LimitsCard.tsx';
import { Shell } from '../../features/shell/Shell.tsx';
import { SYSTEM_REFRESH_MS, useSystem } from '../../features/system/queries.ts';
import { Card, CardBody, CardFoot, CardHead } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { FChip } from '../../ui/FChip/FChip.tsx';
import { Grid12, Grid12Col } from '../../ui/Grid12/Grid12.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { KeyValue } from '../../ui/KeyValue/KeyValue.tsx';
import { List, Row } from '../../ui/List/List.tsx';
import { Menu, MenuAnchor, MenuItem } from '../../ui/Menu/Menu.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { Gauge } from '../../ui/Ring/Gauge.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { Seg, SegItem } from '../../ui/Seg/Seg.tsx';
import { SkelStack } from '../../ui/Skel/Skel.tsx';
import { Spark } from '../../ui/Spark/Spark.tsx';
import { Status } from '../../ui/Status/Status.tsx';
import { TokenChart } from '../../ui/TokenChart/TokenChart.tsx';
import { Caption, Code, Quiet } from '../../ui/atoms/atoms.tsx';
import {
  LOG_FILTERS,
  consumerWords,
  cpuAverage,
  cpuWords,
  diskConsumers,
  diskWords,
  emptyLogWords,
  filteredRows,
  logRows,
  memoryWords,
  networkWords,
  pendingOf,
  processUptimeWords,
  restartNote,
  restartRows,
  sessionsWords,
  showsPerCore,
  sparkOf,
  trafficCaption,
  updatedWords,
  uptimeLabel,
  versionWords,
} from './facts.logic.ts';
import type { LogFilter, LogRow } from './facts.logic.ts';
import { TOKEN_WINDOW, toTokenRequest, windowCount, windowModels, windowRange } from './SystemScreen.logic.ts';
import { useThreadRequests } from './queries.ts';
import './SystemScreen.css';

// The table shows this many rows at first and grows by as many per "Show more".
const TABLE_ROWS = 8;
const TABLE_STEP = 24;
const CLOCK_MS = 60_000;

type View = 'chart' | 'table';
type Facts = ReturnType<typeof useSystem>;

function Loading() {
  return (
    <CardBody>
      <div className="sys-tok-skel" aria-busy="true">
        <SkelStack widths={[42, 100, 100, 100, 64]} />
      </div>
    </CardBody>
  );
}

// A failed read of the facts: the server of an older build has no
// /api/system until the app restarts — a wait, not an error; anything
// else — the failure with Retry.
function FactsFailure({ facts, error }: { facts: Facts; error: Error }) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Note state="wait" icon="hourglass" role="status">
        The server of an older build answers: the machine and the process appear once the app restarts.
      </Note>
    );
  }

  return (
    <Note state="err" role="alert" action="Retry" actionIcon="refresh-cw" actionBusy={facts.isFetching} onAction={() => void facts.refetch()}>
      Couldn’t load the machine and the process — {error.message}
    </Note>
  );
}

function Meter({ gauge, title, lines, children }: { gauge: number | null; title: string; lines: ReactNode[]; children?: ReactNode }) {
  return (
    <div className="sys-meter">
      <div className="sys-meter-h">
        {gauge === null ? (
          <span className="sys-meter-na" role="img" aria-label="not measured yet">
            …
          </span>
        ) : (
          <Gauge value={gauge} />
        )}
        <div className="sys-meter-t">
          <b>{title}</b>
          {lines.map((line, i) => (
            <span key={i}>{line}</span>
          ))}
        </div>
      </div>
      {children}
    </div>
  );
}

function MachineCard({ facts }: { facts: Facts }) {
  const stage = useFactsStage(facts);

  if (stage.kind === 'loading') {
    return (
      <Card narrow="bare" label="Machine">
        <CardHead title="Machine" />
        <div className="sys-skel" aria-busy="true">
          <SkelStack widths={[48, 100, 72]} />
        </div>
      </Card>
    );
  }

  if (stage.kind === 'failed') {
    return (
      <Card narrow="bare" label="Machine">
        <CardHead title="Machine" />
        <CardBody>
          <FactsFailure facts={facts} error={stage.error} />
        </CardBody>
      </Card>
    );
  }

  const { machine } = stage.data;
  const cpu = cpuWords(machine.cpu);
  const average = cpuAverage(machine.cpu.perCore);
  const memory = machine.memory ? memoryWords(machine.memory) : null;
  const disk = machine.disk ? diskWords(machine.disk) : null;
  const consumers = diskConsumers(stage.data);
  const traffic = machine.network ? trafficCaption(machine.network.inboundPerMinute.length) : null;

  return (
    <Card narrow="bare" label="Machine">
      <CardHead title="Machine">
        <Quiet>uptime {uptimeLabel(machine.uptimeSeconds)}</Quiet>
      </CardHead>
      {stage.stale ? (
        <CardBody>
          <Note state="err" role="alert" action="Retry" actionIcon="refresh-cw" actionBusy={facts.isFetching} onAction={() => void facts.refetch()}>
            Couldn’t refresh — showing the facts read before. {stage.stale.message}
          </Note>
        </CardBody>
      ) : null}
      <div className="sys-meters">
        <Meter gauge={average} title={cpu.title} lines={[cpu.load]}>
          {machine.cpu.perCore ? (
            showsPerCore(machine.cpu.perCore) ? (
              <>
                <Spark values={machine.cpu.perCore} />
                <Caption>per core · now</Caption>
              </>
            ) : null
          ) : (
            <Caption>measuring the load…</Caption>
          )}
        </Meter>
        <Meter gauge={memory?.percent ?? null} title="Memory" lines={memory ? [memory.main, memory.swap] : ['not measured on this host']} />
        <Meter gauge={disk?.percent ?? null} title="Disk" lines={disk ? [disk.main] : ['not measured on this host']}>
          <KeyValue items={consumers.items} />
          {consumers.elsewhere ? <Caption>{consumers.elsewhere}</Caption> : null}
        </Meter>
        <div className="sys-meter">
          <div className="sys-meter-h">
            <div className="sys-meter-t">
              <b>Network</b>
              <span>{machine.network ? networkWords(machine.network) : 'not measured on this host'}</span>
            </div>
          </div>
          {machine.network && traffic ? (
            <>
              <Spark values={sparkOf(machine.network.inboundPerMinute)} />
              <Caption>{traffic}</Caption>
            </>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function ProcessCard({ facts, now }: { facts: Facts; now: Date }) {
  const stage = useFactsStage(facts);
  let body: ReactNode;

  if (stage.kind === 'loading') {
    body = (
      <div className="sys-skel" aria-busy="true">
        <SkelStack widths={[64, 48, 56, 72, 40]} />
      </div>
    );
  } else if (stage.kind === 'failed') {
    body = (
      <CardBody>
        <FactsFailure facts={facts} error={stage.error} />
      </CardBody>
    );
  } else {
    const { process, database } = stage.data;
    const version = versionWords(process, now);

    body = (
      <CardBody>
        <KeyValue
          items={[
            { key: 'uptime', value: processUptimeWords(process.startedAt, now) },
            { key: 'memory', value: consumerWords(process.rssBytes) },
            {
              key: 'version',
              value: version.build ? (
                <>
                  <Code>{version.build}</Code>
                  {version.details ? ` · ${version.details}` : ''}
                </>
              ) : (
                'no build stamp — the code runs from its sources, or was built outside a git checkout'
              ),
            },
            ...(version.checkout
              ? [
                  {
                    key: 'checkout',
                    value: (
                      <>
                        <Code>{version.checkout}</Code>
                        {version.build ? ' · not the build running' : ''}
                      </>
                    ),
                  },
                ]
              : []),
            { key: 'node', value: process.node },
            { key: 'agent sessions', value: sessionsWords(process) },
            {
              key: 'database',
              value: database.available ? (
                <>
                  <Status state="done" label="available" /> · {consumerWords(database.sizeBytes)}
                </>
              ) : (
                <>
                  <Status state="err" label="unavailable" />
                  {database.error ? ` · ${database.error}` : ''}
                </>
              ),
            },
          ]}
        />
      </CardBody>
    );
  }

  return (
    <Card narrow="bare" label="Balabash process">
      <CardHead title="Balabash process" />
      {body}
    </Card>
  );
}

function LogRows({ rows, now }: { rows: LogRow[]; now: Date }) {
  const linkTarget = useLinkTargets();

  return (
    <List narrow="tiles">
      {rows.map(row => (
        <Row
          key={row.key}
          {...(row.threadId ? linkTarget({ key: 'thread', id: row.threadId }) : {})}
          lead={<Obj icon={row.icon} size="md" state={row.state} />}
          title={row.title}
          meta={row.meta || undefined}
          end={
            <>
              {row.status ? <Status state={row.status.state} label={row.status.label} /> : null}
              <span className="row-time">
                {dateTimeLabel(row.at, now)}
                {row.sub ? <small className="row-time-sub">{row.sub}</small> : null}
              </span>
            </>
          }
        />
      ))}
    </List>
  );
}

// The restart in the way comes from the facts checked against the log
// (pendingOf): the log alone holds the newest 50 system events, and a
// request behind 50 exceptions would be lost from it.
function RestartsCard({ facts, now }: { facts: Facts; now: Date }) {
  const log = useAppSelector(selectSystemLog);
  const rows = useMemo(() => restartRows(logRows(log)), [log]);
  const pending = pendingOf(log, facts.data?.restart.pending);
  const note = pending ? restartNote(pending.request, pending.waiting, now) : null;

  return (
    <Card narrow="bare" label="Restarts">
      <CardHead title="Restarts" />
      {note ? (
        <CardBody>
          <Note state="wait" icon="hourglass" role="status">
            <span className="sys-wait">
              {note.lead}
              {note.tail}
              {note.threads.map((thread, i) => (
                <span key={thread.id}>
                  {i > 0 ? ', ' : ' '}
                  <Link route={{ key: 'thread', id: thread.id }}>{thread.title ?? thread.agent}</Link>
                </span>
              ))}
            </span>
          </Note>
        </CardBody>
      ) : null}
      {rows.length > 0 ? (
        <LogRows rows={rows} now={now} />
      ) : (
        <Empty icon="rotate-ccw" title="No restarts yet">
          Restarts and what broke a boot appear here as they happen.
        </Empty>
      )}
    </Card>
  );
}

function EventLogCard({ now }: { now: Date }) {
  const log = useAppSelector(selectSystemLog);
  const [filter, setFilter] = useState<LogFilter>('all');
  const [menu, setMenu] = useState(false);
  const rows = useMemo(() => filteredRows(logRows(log), filter), [log, filter]);
  const current = LOG_FILTERS.find(item => item.key === filter) ?? LOG_FILTERS[0];

  return (
    <Card narrow="bare" label="System event log">
      <CardHead title="System event log" count={rows.length} />
      <CardBody className="fbar">
        <div className="fbar-filters">
          <MenuAnchor
            open={menu}
            onClose={() => setMenu(false)}
            menu={
              <Menu label="Type">
                {LOG_FILTERS.map(item => (
                  <MenuItem
                    key={item.key}
                    icon={item.icon}
                    label={item.label}
                    checked={item.key === filter}
                    onClick={() => {
                      setFilter(item.key);
                      setMenu(false);
                    }}
                  />
                ))}
              </Menu>
            }
          >
            <FChip icon="filter" label="Type" value={current.label} end="chevron-down" expanded={menu} onClick={() => setMenu(open => !open)} />
          </MenuAnchor>
        </div>
      </CardBody>
      {rows.length > 0 ? (
        <LogRows rows={rows} now={now} />
      ) : (
        <Empty icon="activity" title={emptyLogWords(filter)}>
          Restarts, exceptions and migration failures of the system land here.
        </Empty>
      )}
    </Card>
  );
}

export function SystemScreen() {
  const me = useAppSelector(selectMe);
  const main = useAppSelector(selectMainThread);
  const now = useNow(CLOCK_MS);
  const facts = useSystem();
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
  } else {
    const shown = Math.min(tableRows, rows.length);
    // A failed refresh over the window loaded before — empty or not.
    const stale = query.isError ? (
      <CardBody>
        <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" actionBusy={query.isFetching} onAction={() => void query.refetch()}>
          Couldn’t refresh — showing the requests loaded before. {query.error.message}
        </Note>
      </CardBody>
    ) : null;

    body = rows.length === 0 ? (
      <>
        {stale}
        <Empty icon="activity" title="No requests yet">
          The main thread has not called the model yet.
        </Empty>
      </>
    ) : (
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
        {stale}
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
    <Shell current="system" title="System" sub={updatedWords(facts.dataUpdatedAt, SYSTEM_REFRESH_MS) ?? undefined}>
      <Screen>
        <Grid12>
          <Grid12Col span={12}>
            <MachineCard facts={facts} />
          </Grid12Col>
          <Grid12Col span={5}>
            <ProcessCard facts={facts} now={now} />
          </Grid12Col>
          <Grid12Col span={7}>
            <RestartsCard facts={facts} now={now} />
          </Grid12Col>
          <Grid12Col span={12}>
            <LimitsCard scope="system" />
          </Grid12Col>
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
          <Grid12Col span={12}>
            <EventLogCard now={now} />
          </Grid12Col>
        </Grid12>
      </Screen>
    </Shell>
  );
}

export type { SystemResponse };
