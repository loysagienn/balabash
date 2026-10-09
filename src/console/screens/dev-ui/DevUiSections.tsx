// The design's "Sections" and data showcases in code: list rows (threads,
// apps), tiles, section links, limits, stats, chart, sparklines, data
// table, list-and-details, filter bar, terminal output, and the same blocks
// at phone width. Store-free: a headless scene can mount it alone.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { AppRow } from '../../ui/AppRow/AppRow.tsx';
import { BarChart } from '../../ui/BarChart/BarChart.tsx';
import { ActionLink, Btn } from '../../ui/Btn/Btn.tsx';
import { Card, CardBody, CardHead } from '../../ui/Card/Card.tsx';
import { DataTable, DtShare, DtWho } from '../../ui/DataTable/DataTable.tsx';
import { FBar } from '../../ui/FBar/FBar.tsx';
import { FChip } from '../../ui/FChip/FChip.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { KeyValue } from '../../ui/KeyValue/KeyValue.tsx';
import { Limit, Limits } from '../../ui/Limit/Limit.tsx';
import { List, ListGroup, Row } from '../../ui/List/List.tsx';
import { Menu, MenuAnchor, MenuItem, MenuSep } from '../../ui/Menu/Menu.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { ProjectTile, Tiles } from '../../ui/ProjectTile/ProjectTile.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { SectionLink, SectionLinks } from '../../ui/SectionLink/SectionLink.tsx';
import { Seg, SegItem } from '../../ui/Seg/Seg.tsx';
import { Spark } from '../../ui/Spark/Spark.tsx';
import { Split, SplitDetail, SplitList, DetailSection } from '../../ui/Split/Split.tsx';
import { Stat, Stats } from '../../ui/Stat/Stat.tsx';
import { Status } from '../../ui/Status/Status.tsx';
import { TermErr, TermLine, Terminal, Trunc } from '../../ui/Terminal/Terminal.tsx';
import { ThreadRow } from '../../ui/ThreadRow/ThreadRow.tsx';
import { ActGroup, Xp } from '../../ui/Xp/Xp.tsx';
import { Caption, Code, Kbd, Tag } from '../../ui/atoms/atoms.tsx';

const stop = (event: { preventDefault: () => void }) => event.preventDefault();

// The longest slug the server allows (64 characters).
const LONG_URL = '/p/calorie-tracker-with-macro-counts-and-a-weekly-report-for-family';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dev-sec">
      <h2 className="dev-sec-t">{title}</h2>
      {children}
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div className="dev-row">
      <Caption>{children}</Caption>
    </div>
  );
}

// 14 days ending on Oct 8: a label under every seventh bar, the last bar is today.
const CHART_DAYS = Array.from({ length: 14 }, (_, i) => {
  const date = new Date(Date.UTC(2026, 8, 25 + i));
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
});
const CHART_COLS = [18, 42, 36, 58, 24, 8, 4, 62, 71, 55, 80, 66, 30, 48].map((v, i) => ({
  v,
  x: i % 7 === 0 || i === 13 ? CHART_DAYS[i] : undefined,
  title: `${Math.round(v * 0.62)}M tokens`,
  detail: i === 13 ? `${CHART_DAYS[i]} · today` : `${CHART_DAYS[i]}, 2026`,
  current: i === 13,
}));

function ThreadRows({ endCols }: { endCols?: string }) {
  return (
    <List endCols={endCols} timeW={endCols ? undefined : '96px'} narrow="tiles">
      <ListGroup end="7 threads">Today, October 9</ListGroup>
      <ThreadRow
        agent="engineer"
        title="Mini-apps: publishing by slug"
        state="run"
        project="Balabash"
        lastCode="npm run build"
        time="since 14:02"
        sub="running 2h 36m"
        ctx={{ percentage: 62, usedTokens: 124000, maxTokens: 200000 }}
        href="#"
        onClick={stop}
        fresh
      />
      <ThreadRow
        agent="gardener"
        title="Inbox review: Renovation"
        state="run"
        headless
        project="Renovation"
        lastCode="Edit journal.md"
        time="since 16:31"
        sub="running 7m"
        ctx={{ percentage: 9 }}
        href="#"
        onClick={stop}
      />
      <ThreadRow
        agent="coordinator"
        title="Sort contractor emails"
        state="wait"
        project="Renovation"
        kids={1}
        last="Waiting for the browser agent"
        time="16:42"
        sub="idle 4m"
        ctx={{ percentage: 31, usedTokens: 62000, maxTokens: 200000 }}
        href="#"
        onClick={stop}
      />
      <ThreadRow
        agent="browser"
        title="Yandex.Direct: weekly report"
        state="act"
        project="Caloriu promo"
        last="Sign-in required"
        time="since 15:10"
        sub="action needed 12m"
        ctx={{ percentage: 84 }}
        href="#"
        onClick={stop}
        current
      />
      <ListGroup end="5 threads">Yesterday, October 8</ListGroup>
      <ThreadRow
        agent="manager"
        title="Renovation estimate: reconciling contractors"
        state="done"
        project="Renovation"
        kids={3}
        desc="Three estimates reconciled; a ₽84,000 gap on electrics — question sent to the contractor."
        time="11:20 → 12:25"
        sub="1h 05m"
        href="#"
        onClick={stop}
      />
      <ThreadRow
        agent="browser"
        title="Checking /p/kcal in the browser"
        state="err"
        project="Balabash"
        desc="Session exited with code 1: ECONNRESET on an API request."
        time="23:10 → 23:14"
        sub="4m"
        href="#"
        onClick={stop}
      />
      <ThreadRow
        agent="scheduler"
        title="Morning digest"
        state="off"
        headless
        noAgent
        desc="Cancelled by the operator before the first turn."
        time="09:00 → 09:00"
        sub="12s"
        href="#"
        onClick={stop}
      />
      <ThreadRow
        agent="unknown-agent"
        title="Publishing by slug: search match"
        state="done"
        desc="Apps get a slug when published; the slug is freed after 7 days."
        hit="slug"
        time="Oct 2, 10:00 → 10:40"
        sub="40m"
        href="#"
        onClick={stop}
      />
    </List>
  );
}

function AppRows({ menuOpen, onMenu }: { menuOpen: boolean; onMenu: (open: boolean) => void }) {
  return (
    <>
      <Label>link rows: published · not published · manifest error · the longest allowed slug (64 characters)</Label>
      <List>
        <AppRow title="Calorie tracker" desc="Food diary with macro counts" url="/p/kcal" href="#" onClick={stop} />
        <AppRow title="Reading list" desc="Books to read, with notes" href="#" onClick={stop} />
        <AppRow title="Long slug" desc="The address ends in an ellipsis, the whole value is in its title" url={LONG_URL} href="#" onClick={stop} />
        <AppRow
          title="Expenses"
          desc="Monthly budget by category"
          err="endpoints[2].sql: expected a string, got number"
          href="#"
          onClick={stop}
        />
      </List>
      <Label>rows with actions (the “Apps” section): folder, URL as a link, “Open”, “⋯”</Label>
      <List>
        <AppRow
          actions
          title="Calorie tracker"
          desc="Food diary with macro counts"
          folder="apps/kcal"
          url="/p/kcal"
          appHref="https://kcal.apps.example"
          more={
            <MenuAnchor
              open={menuOpen}
              onClose={() => onMenu(false)}
              menu={
                <Menu label="App actions">
                  <MenuItem icon="pencil" label="Edit manifest" onClick={() => onMenu(false)} />
                  <MenuItem icon="folder" label="Open folder" onClick={() => onMenu(false)} />
                  <MenuSep />
                  <MenuItem icon="eye-off" label="Unpublish" variant="danger" onClick={() => onMenu(false)} />
                </Menu>
              }
            >
              <IconBtn icon="ellipsis" label="App actions" size="sm" expanded={menuOpen} onClick={() => onMenu(!menuOpen)} />
            </MenuAnchor>
          }
        />
        <AppRow
          actions
          title="Expenses"
          desc="Monthly budget by category"
          folder="apps/expenses"
          err="endpoints[2].sql: expected a string, got number"
          more={<IconBtn icon="ellipsis" label="App actions" size="sm" />}
        />
        <AppRow
          actions
          title="Long slug"
          desc="The address takes at most half the row; the title keeps its place"
          folder="apps/long-slug"
          url={LONG_URL}
          appHref="https://long.apps.example"
          more={<IconBtn icon="ellipsis" label="App actions" size="sm" />}
        />
      </List>
    </>
  );
}

function ProjectTiles() {
  return (
    <Tiles>
      <ProjectTile
        title="Renovation"
        desc="Apartment on Petrogradsky: estimate, contractors, work schedule"
        when="7 min ago"
        slug="renovation/"
        threads={1}
        href="#"
        onClick={stop}
      />
      <ProjectTile
        title="Balabash"
        desc="Developing Balabash itself: web UI, agents, infrastructure"
        when="12 min ago"
        slug="balabash/"
        threads={2}
        href="#"
        onClick={stop}
      />
      <ProjectTile title="Vacation 2027" desc="Japan in April: route, tickets, ryokans" when="3 days ago" slug="vacation-2027/" href="#" onClick={stop} />
      <ProjectTile title="Old blog" desc="Archived with its drafts" when="Aug 2" slug="old-blog/" archived href="#" onClick={stop} />
    </Tiles>
  );
}

function Sections({ narrow }: { narrow?: 'tiles' }) {
  return (
    <SectionLinks narrow={narrow}>
      <SectionLink icon="messages-square" title="Threads" meta="4 active · 1,312 total" href="#" onClick={stop} />
      <SectionLink icon="folder" title="Projects" meta="9 active · 3 archived" href="#" onClick={stop} />
      <SectionLink icon="calendar-clock" title="Schedule" meta="7 tasks · next at 17:00" href="#" onClick={stop} />
      <SectionLink icon="plug" title="Connections" meta="1 needs sign-in" state="act" href="#" onClick={stop} />
      <SectionLink icon="bot" title="Agents" meta="11 agents" href="#" onClick={stop} />
      <SectionLink icon="activity" title="System" meta="CPU 14% · disk 66%" href="#" onClick={stop} />
    </SectionLinks>
  );
}

function LimitItems() {
  return (
    <>
      <Limit title="5 hours" meta="resets at 18:00 · in 1h 22m" value={47} label="normal" />
      <Limit title="7 days" meta="resets Mon, 10:00 · in 4d" value={81} label="warning" />
      <Limit title="7 days · Opus" meta="resets Mon, 10:00 · in 4d" value={100} label="exhausted · overage" />
    </>
  );
}

function ScheduleRows({ current }: { current: 'backup' | 'digest' }) {
  return (
    <List narrow="tiles">
      <Row
        href="#"
        onClick={stop}
        current={current === 'backup'}
        lead={<Obj icon="square-terminal" size="md" />}
        title="DB backup"
        meta={
          <>
            <Tag>command</Tag> daily at 4:00
          </>
        }
        end={
          <>
            <Status state="err" label="didn’t start · 04:00" />
            <span className="row-time">
              tomorrow, 4:00<small className="row-time-sub">next</small>
            </span>
          </>
        }
      />
      <Row
        href="#"
        onClick={stop}
        current={current === 'digest'}
        lead={<Obj icon="file-code" size="md" />}
        title="Morning digest"
        meta={
          <>
            <Tag>code</Tag> weekdays at 9:00
          </>
        }
        end={
          <>
            <Status state="done" label="9:00" />
            <span className="row-time">
              tomorrow, 9:00<small className="row-time-sub">next</small>
            </span>
          </>
        }
      />
    </List>
  );
}

function ScheduleDetail() {
  return (
    <Card narrow="bare">
      <CardHead title="DB backup" tag="command">
        <Btn label="Run now" icon="play" size="sm" />
        <IconBtn icon="ellipsis" label="More" size="sm" />
      </CardHead>
      <DetailSection>
        <KeyValue
          items={[
            {
              key: 'schedule',
              value: (
                <>
                  daily at 4:00 · <Code>0 4 * * *</Code>
                </>
              ),
            },
            { key: 'next', value: 'tomorrow, 4:00' },
            { key: 'timeout', value: '10m' },
          ]}
        />
      </DetailSection>
      <DetailSection title="Runs" end={<ActionLink label="Full log" href="#" onClick={stop} />}>
        <ActGroup>
          <Xp state="err" icon="circle-x" endState="err" end="didn’t start" tool="Oct 8, 04:00" arg="scheduled · exit 127" />
          <Xp state="done" icon="circle-check" end="41s" tool="Oct 7, 04:00" arg="scheduled · exit 0" />
        </ActGroup>
      </DetailSection>
    </Card>
  );
}

function FilterBars({ search, onSearch }: { search: string; onSearch: (value: string) => void }) {
  const [mode, setMode] = useState('all');
  const [pmode, setPmode] = useState('active');

  return (
    <>
      <Label>filters and search</Label>
      <FBar
        filters={
          <>
            <Seg label="Status">
              <SegItem label="Active" n={4} sel={mode === 'active'} onClick={() => setMode('active')} />
              <SegItem label="Completed" n="1,290" sel={mode === 'completed'} onClick={() => setMode('completed')} />
              <SegItem label="All" n="1,312" sel={mode === 'all'} onClick={() => setMode('all')} />
            </Seg>
            <FChip label="Agent" />
            <FChip label="Project" />
          </>
        }
        search={<Input value={search} onChange={onSearch} placeholder="Search titles and summaries" lead="search" end={<Kbd>/</Kbd>} ariaLabel="Search threads" />}
      />
      <Label>search and “Create”</Label>
      <FBar
        filters={
          <Seg label="Projects">
            <SegItem label="Active" n={9} sel={pmode === 'active'} onClick={() => setPmode('active')} />
            <SegItem label="Archived" n={3} sel={pmode === 'archived'} onClick={() => setPmode('archived')} />
          </Seg>
        }
        search={
          <>
            <Input value={search} onChange={onSearch} placeholder="Search projects" lead="search" ariaLabel="Search projects" />
            <Btn label="Create" icon="plus" variant="primary" />
          </>
        }
      />
    </>
  );
}

function TypesTerminal() {
  return (
    <>
      <Terminal>
        <TermLine dim>$ npm run types</TermLine>
        <TermLine dim>&gt; balabash@0.42.0 types</TermLine>
        <TermLine dim>&gt; tsc --noEmit</TermLine>
        <TermLine />
        <TermLine>
          src/api/apps.ts(118,7): <TermErr>error TS2322</TermErr>: Type 'string | undefined' is not assignable to type 'string'.
        </TermLine>
        <TermLine>
          src/api/apps.ts(131,12): <TermErr>error TS2345</TermErr>: Argument of type 'Slug' is not assignable to parameter of type 'string'.
        </TermLine>
      </Terminal>
      <Trunc>
        showing the last 40 of 212 lines ·{' '}
        <a href="#" onClick={stop}>
          full output
        </a>
      </Trunc>
    </>
  );
}

export function DevUiSections() {
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState('');

  return (
    <>
      <Section title="ThreadRow: the six states, columns across the list (endCols), headless, children, summary, search match">
        <Card>
          <CardHead title="Threads" count={4} countState="run" link={<ActionLink label="All · 1,312" href="#" onClick={stop} />} />
          <ThreadRows endCols="auto 140px 60px" />
        </Card>
      </Section>

      <Section title="AppRow">
        <Card>
          <CardHead title="Apps" count={3} />
          <AppRows menuOpen={menu} onMenu={setMenu} />
        </Card>
      </Section>

      <Section title="ProjectTile · SectionLink · Limit">
        <Label>tiles: running threads, archived</Label>
        <ProjectTiles />
        <Label>small tiles (data-size=sm)</Label>
        <Tiles min="180px">
          <ProjectTile title="Renovation" when="7 min ago" slug="renovation/" threads={1} size="sm" href="#" onClick={stop} />
          <ProjectTile title="Balabash" when="12 min ago" slug="balabash/" size="sm" href="#" onClick={stop} />
        </Tiles>
        <Label>section links; the summary is colored only where action awaits</Label>
        <Card>
          <CardHead title="Sections" />
          <CardBody>
            <Sections />
          </CardBody>
        </Card>
        <Label>limits in a row (as many as fit), loading, stacked</Label>
        <div className="dev-box">
          <Limits>
            <LimitItems />
          </Limits>
        </div>
        <div className="dev-box">
          <Limits>
            <Limit loading />
            <Limit loading />
            <Limit loading />
          </Limits>
        </div>
        <div className="dev-grid">
          <div className="dev-box">
            <Limits layout="stack">
              <LimitItems />
            </Limits>
          </div>
          <div className="dev-box">
            <Limits layout="stack">
              <Limit loading />
            </Limits>
          </div>
        </div>
      </Section>

      <Section title="Stat · BarChart · Spark · DataTable">
        <Stats>
          <Stat label="Requests" value="1,284" desc="over 14 days" />
          <Stat label="Input" value="118M" />
          <Stat label="Cache" value="266M" desc="cache reads" />
          <Stat label="Output" value="19M" />
          <Stat label="Errors" value="7" desc="0.5% of requests" state="err" />
          <Stat label="Sign-in" value="1" desc="connection awaits" state="act" />
        </Stats>
        <Label>bar chart in a card (System): one series, a tooltip on hover and focus — kept inside the plot on the edge bars, the last day is current</Label>
        <Card>
          <CardHead title="Tokens per day" />
          <CardBody>
            <BarChart label="Tokens per day over 14 days" y={['0', '10M', '20M', '30M', '40M', '50M']} cols={CHART_COLS} />
          </CardBody>
        </Card>
        <Label>sparklines: per core · traffic over an hour · muted</Label>
        <div className="dev-row">
          <div style={{ width: 160 }}>
            <Spark values={[22, 9, 31, 6, 14, 3, 18, 8]} />
          </div>
          <div style={{ width: 240 }}>
            <Spark values={[20, 35, 30, 60, 45, 80, 55, 40, 65, 50, 70, 45]} />
          </div>
          <div style={{ width: 120 }}>
            <Spark values={[20, 35, 30, 60, 45, 80]} muted />
          </div>
        </div>
        <Label>data table: numbers right-aligned, wide columns hide under 520 px</Label>
        <div className="dev-grid" data-wide="">
          <Card>
            <CardHead title="Usage by agent" tag="14 days" />
            <DataTable
              label="Usage by agent"
              cols={[
                { label: 'agent' },
                { label: 'requests', num: true, wide: true },
                { label: 'tokens', num: true },
                { label: 'model time', num: true, wide: true },
                { label: 'token share' },
              ]}
              rows={[
                { key: 'engineer', cells: [<DtWho agent="engineer" />, '302', '128M', '6h 12m', <DtShare value={33} />] },
                { key: 'browser', cells: [<DtWho agent="browser" />, '388', '91M', '4h 40m', <DtShare value={24} />] },
                { key: 'coordinator', cells: [<DtWho agent="coordinator" />, '236', '20M', '41m', <DtShare value={5} />] },
              ]}
            />
          </Card>
          <div style={{ maxWidth: 420 }}>
            <Card>
              <CardHead title="Cramped (wide columns hidden)" />
              <DataTable
                cols={[
                  { label: 'agent' },
                  { label: 'requests', num: true, wide: true },
                  { label: 'tokens', num: true },
                  { label: 'token share' },
                ]}
                rows={[
                  { key: 'engineer', cells: [<DtWho agent="engineer" />, '302', '128M', <DtShare value={33} />] },
                  { key: 'browser', cells: [<DtWho agent="browser" />, '388', '91M', <DtShare value={24} />] },
                ]}
              />
            </Card>
          </div>
        </div>
      </Section>

      <Section title="FBar">
        <FilterBars search={search} onSearch={setSearch} />
      </Section>

      <Section title="Split: list and details side by side, DetailSection headings">
        <Split view="list">
          <SplitList>
            <Card narrow="bare">
              <ScheduleRows current="backup" />
            </Card>
          </SplitList>
          <SplitDetail>
            <ScheduleDetail />
          </SplitDetail>
        </Split>
      </Section>

      <Section title="Terminal · Trunc">
        <div className="dev-grid" data-wide="">
          <div className="dev-col" style={{ alignItems: 'stretch' }}>
            <TypesTerminal />
          </div>
          <ActGroup>
            <Xp state="err" icon="square-terminal" endState="err" end="exit 2 · 8.4s" defaultOpen tool="Bash" arg="npm run types">
              <TypesTerminal />
            </Xp>
          </ActGroup>
        </div>
      </Section>

      <Section title="Sections at phone width (390): bare cards, rows and limits as tiles, sections 3 × N, the details screen, the filter strip">
        <div className="dev-row" style={{ alignItems: 'flex-start' }}>
          <div className="dev-phone">
            <div className="dev-shell">
              <Screen>
                <FBar
                  filters={
                    <>
                      <Seg label="Status">
                        <SegItem label="Active" n={4} sel />
                        <SegItem label="Completed" n="1,290" sel={false} />
                        <SegItem label="All" n="1,312" sel={false} />
                      </Seg>
                      <FChip label="Agent" value="engineer" />
                      <FChip label="Project" />
                    </>
                  }
                  search={<Input value={search} onChange={setSearch} placeholder="Search" lead="search" end={<Kbd>/</Kbd>} ariaLabel="Search" />}
                />
                <Card narrow="bare">
                  <CardHead title="Project threads" count={1} countState="run" link={<ActionLink label="All · 14" href="#" onClick={stop} />} />
                  <ThreadRows />
                </Card>
                <Card narrow="bare">
                  <CardHead title="Claude limits" />
                  <Limits layout="stack" narrow="tiles">
                    <LimitItems />
                  </Limits>
                </Card>
                <Card narrow="bare">
                  <CardHead title="Sections" />
                  <CardBody>
                    <Sections narrow="tiles" />
                  </CardBody>
                </Card>
                <Card narrow="bare">
                  <CardHead title="Projects" />
                  <CardBody>
                    <ProjectTiles />
                  </CardBody>
                </Card>
              </Screen>
            </div>
          </div>
          <div className="dev-phone">
            <div className="dev-shell">
              <Screen>
                <Split view="detail">
                  <SplitList>
                    <Card narrow="bare">
                      <ScheduleRows current="backup" />
                    </Card>
                  </SplitList>
                  <SplitDetail>
                    <ScheduleDetail />
                  </SplitDetail>
                </Split>
                <Caption>view="detail": the list is hidden on the phone</Caption>
                <Card narrow="bare">
                  <CardHead title="Apps" />
                  <List narrow="tiles">
                    <AppRow title="Calorie tracker" desc="Food diary with macro counts" url="/p/kcal" href="#" onClick={stop} />
                    <AppRow title="Reading list" desc="Books to read, with notes" href="#" onClick={stop} />
                  </List>
                </Card>
                <Card narrow="bare">
                  <CardHead title="Usage" />
                  <DataTable
                    cols={[{ label: 'agent' }, { label: 'requests', num: true, wide: true }, { label: 'tokens', num: true }, { label: 'share' }]}
                    rows={[
                      { key: 'engineer', cells: [<DtWho agent="engineer" />, '302', '128M', <DtShare value={33} />] },
                      { key: 'browser', cells: [<DtWho agent="browser" />, '388', '91M', <DtShare value={24} />] },
                    ]}
                  />
                </Card>
              </Screen>
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
