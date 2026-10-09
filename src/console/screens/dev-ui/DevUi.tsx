// The showcase (/dev/ui): every ported block in its variants and states,
// side by side with the design's showcases for checking by eye. Grows with
// each block that lands in ui/.

import { useState } from 'react';
import { useAppDispatch } from '../../store/hooks.ts';
import { pushToast } from '../../store/ui/actions.ts';
import type { ReactNode } from 'react';
import { Shell } from '../../features/shell/Shell.tsx';
import { ActivityChip } from '../../ui/ActivityChip/ActivityChip.tsx';
import { Avatar } from '../../ui/Avatar/Avatar.tsx';
import { AGENT_AVATARS } from '../../ui/Avatar/agents.ts';
import { Badge } from '../../ui/Badge/Badge.tsx';
import { ActionLink, Btn } from '../../ui/Btn/Btn.tsx';
import { Card, CardBody, CardFoot, CardHead } from '../../ui/Card/Card.tsx';
import { Confirm } from '../../ui/Confirm/Confirm.tsx';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { Check } from '../../ui/Check/Check.tsx';
import { Crumbs } from '../../ui/Crumbs/Crumbs.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { FChip } from '../../ui/FChip/FChip.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Hint, Tip } from '../../ui/Hint/Hint.tsx';
import { Icon } from '../../ui/Icon/Icon.tsx';
import { ICONS } from '../../ui/Icon/icons.ts';
import type { IconName } from '../../ui/Icon/Icon.tsx';
import { IconBtn } from '../../ui/IconBtn/IconBtn.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { List, ListGroup, LoadMore } from '../../ui/List/List.tsx';
import { Menu, MenuAnchor, MenuItem, MenuLabel, MenuSep } from '../../ui/Menu/Menu.tsx';
import { Modal } from '../../ui/Modal/Modal.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { PageHead } from '../../ui/PageHead/PageHead.tsx';
import { Prog } from '../../ui/Prog/Prog.tsx';
import { Ctx } from '../../ui/Ring/Ctx.tsx';
import { Gauge } from '../../ui/Ring/Gauge.tsx';
import { Ring } from '../../ui/Ring/Ring.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { Seg, SegItem } from '../../ui/Seg/Seg.tsx';
import { Sheet } from '../../ui/Sheet/Sheet.tsx';
import { SkelRow, SkelStack } from '../../ui/Skel/Skel.tsx';
import { Status } from '../../ui/Status/Status.tsx';
import { Tab, Tabs } from '../../ui/Tabs/Tabs.tsx';
import { Toast } from '../../ui/Toast/Toast.tsx';
import { ThreadRow } from '../../ui/ThreadRow/ThreadRow.tsx';
import { Attn, Caption, Code, Count, ErrorLine, Hit, Kbd, Pulse, Quiet, Tag, Url } from '../../ui/atoms/atoms.tsx';
import type { StateName } from '../../ui/atoms/atoms.tsx';
import { DevUiFeed } from './DevUiFeed.tsx';
import { DevUiFiles } from './DevUiFiles.tsx';
import { DevUiSections } from './DevUiSections.tsx';
import { DevUiShell } from './DevUiShell.tsx';
import './DevUi.css';

const STATES: StateName[] = ['run', 'wait', 'act', 'done', 'err', 'off'];
const STATE_LABEL: Record<StateName, string> = {
  run: 'running',
  wait: 'waiting',
  act: 'reply needed',
  done: 'done',
  err: 'crashed',
  off: 'cancelled',
};
const AGENTS = Object.keys(AGENT_AVATARS);
const stop = (event: { preventDefault: () => void }) => event.preventDefault();

// Throws while rendering — the way to see app/ErrorBoundary.tsx (the
// Crashed card) on the showcase; a reload brings the showcase back.
function Boom(): never {
  throw new Error('dev/ui: a component threw while rendering (on purpose)');
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dev-sec">
      <h2 className="dev-sec-t">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="dev-row">
      {children}
      {label ? <Caption>{label}</Caption> : null}
    </div>
  );
}

export function DevUi() {
  const [text, setText] = useState('K7QM2X');
  const [area, setArea] = useState('');
  const [checks, setChecks] = useState({ box: true, radio: 'a', tgl: false });
  const [seg, setSeg] = useState('active');
  const [tab, setTab] = useState('tasks');
  const [overlay, setOverlay] = useState<'modal' | 'sheet' | 'form' | 'dialog' | null>(null);
  const [menu, setMenu] = useState(false);
  const [cardMenu, setCardMenu] = useState(false);
  const [toasts, setToasts] = useState([1, 2, 3, 4]);
  const [confirm, setConfirm] = useState(false);
  const [crash, setCrash] = useState(false);
  const dispatch = useAppDispatch();

  return (
    <Shell current={null} title="UI kit" sub="/dev/ui · blocks of the design system in code">
      <Screen>
        <Section title="Foundations · state context">
          <Row>
            {STATES.map(state => (
              <span key={state} className="dev-state" data-state={state}>
                {state}
              </span>
            ))}
          </Row>
          <Row label="identifiers 1–8 and you">
            {[1, 2, 3, 4, 5, 6, 7, 8, 'you'].map(id => (
              <span key={id} className="dev-id" data-id={id}>
                {id}
              </span>
            ))}
          </Row>
        </Section>

        <Section title="Icon">
          <Row label="xs · sm · default · md · lg · xl · spin">
            <Icon name="play" size="xs" />
            <Icon name="play" size="sm" />
            <Icon name="play" />
            <Icon name="play" size="md" />
            <Icon name="play" size="lg" />
            <Icon name="play" size="xl" />
            <Icon name="loader-circle" spin />
          </Row>
          <Row>
            {(Object.keys(ICONS) as IconName[]).map(name => (
              <span key={name} className="dev-icon" title={name}>
                <Icon name={name} />
                <Caption>{name}</Caption>
              </span>
            ))}
          </Row>
        </Section>

        <Section title="Btn · IconBtn">
          <Row label="regular · primary · ghost · danger">
            <Btn label="Save" />
            <Btn label="Save" variant="primary" />
            <Btn label="Save" variant="ghost" />
            <Btn label="Delete" variant="danger" icon="trash-2" />
          </Row>
          <Row label="sm · default · lg · with icon · icon after · kbd">
            <Btn label="Run" size="sm" icon="play" />
            <Btn label="Run" icon="play" />
            <Btn label="Run" size="lg" icon="play" />
            <Btn label="All threads" iconAfter="chevron-right" variant="ghost" />
            <Btn label="Search" icon="search" kbd="⌘K" />
          </Row>
          <Row label="busy · disabled · link">
            <Btn label="Signing in" variant="primary" busy />
            <Btn label="Save" disabled />
            <Btn label="Open" href="#" icon="external-link" />
          </Row>
          <Row label="icon buttons: ghost (default) · regular · sm">
            <IconBtn icon="ellipsis" label="More" />
            <IconBtn icon="x" label="Close" variant="regular" />
            <IconBtn icon="arrow-left" label="Back" size="sm" />
          </Row>
          <Row label="block">
            <div style={{ width: 280 }}>
              <Btn label="Sign in" variant="primary" block />
            </div>
          </Row>
        </Section>

        <Section title="Input · Field">
          <div className="dev-grid">
            <Field label="One-time code" fid="dev-code" hint="Mono input">
              <Input id="dev-code" value={text} onChange={setText} mono autoComplete="off" />
            </Field>
            <Field label="Search" fid="dev-search" opt="optional">
              <Input
                id="dev-search"
                value=""
                onChange={() => undefined}
                lead="search"
                placeholder="Search"
                end={<Kbd>⌘K</Kbd>}
              />
            </Field>
            <Field label="Slug" fid="dev-slug" err="Already taken" required>
              <Input id="dev-slug" value="balabash" onChange={() => undefined} pre="/p/" mono invalid />
            </Field>
            <Field label="Disabled" fid="dev-dis">
              <Input id="dev-dis" value="cannot edit" onChange={() => undefined} disabled />
            </Field>
            <Field label="Description" fid="dev-area" hintCode="Markdown">
              <Input as="textarea" id="dev-area" value={area} onChange={setArea} placeholder="A few lines" />
            </Field>
          </div>
        </Section>

        <Section title="Atoms">
          <Row label="count: plain · run · act · err · sm">
            <Count>12</Count>
            <Count state="run">4</Count>
            <Count state="act">3</Count>
            <Count state="err">1</Count>
            <Count size="sm" state="run">
              4
            </Count>
          </Row>
          <Row label="attn · pulse · pulse off · kbd · code · tag · quiet">
            <Attn />
            <Pulse />
            <Pulse off />
            <Kbd>⌘K</Kbd>
            <Code>npm run build</Code>
            <Tag>task</Tag>
            <Quiet>not published</Quiet>
          </Row>
          <Row label="url (text · link) · hit · errline">
            <Url>/p/kcal</Url>
            <Url href="https://example.test/p/kcal">/p/kcal</Url>
            <span>
              publishing by <Hit>slug</Hit>
            </span>
            <ErrorLine>
              Manifest error: <Code wrap>endpoints[2].sql: expected a string</Code>
            </ErrorLine>
          </Row>
        </Section>

        <Section title="Obj">
          <Row label="sm · md · default · lg · xl · state · dir">
            <Obj icon="file-text" size="sm" />
            <Obj icon="file-text" size="md" />
            <Obj icon="file-text" />
            <Obj icon="file-text" size="lg" />
            <Obj icon="file-text" size="xl" />
            {STATES.map(state => (
              <Obj key={state} icon="circle-alert" state={state} />
            ))}
            <Obj icon="folder" kind="dir" />
          </Row>
        </Section>

        <Section title="ActivityChip">
          <Row label="4 running · expanded · compact · all quiet">
            <ActivityChip running={4} />
            <ActivityChip running={4} expanded />
            <ActivityChip running={4} compact />
            <ActivityChip running={0} />
          </Row>
        </Section>

        <Section title="Empty">
          <div className="dev-grid">
            <div className="dev-box">
              <Empty icon="messages-square" title="Nothing running right now">
                Agents start threads when there is work.
              </Empty>
            </div>
            <div className="dev-box">
              <Empty
                icon="circle-alert"
                state="err"
                title="Couldn’t load threads"
                action="Try again"
                actionIcon="refresh-cw"
              >
                HTTP 502 · the server did not answer.
              </Empty>
            </div>
          </div>
        </Section>

        <Section title="Check">
          <Row label="checkbox · radio · switch · disabled">
            <Check
              label="Notify on successful runs"
              checked={checks.box}
              onChange={box => setChecks({ ...checks, box })}
            />
            <Check
              kind="radio"
              name="dev-r"
              label="Desktop"
              checked={checks.radio === 'a'}
              onChange={() => setChecks({ ...checks, radio: 'a' })}
            />
            <Check
              kind="radio"
              name="dev-r"
              label="Phone"
              checked={checks.radio === 'b'}
              onChange={() => setChecks({ ...checks, radio: 'b' })}
            />
            <Check
              kind="switch"
              label="Light theme"
              checked={checks.tgl}
              onChange={tgl => setChecks({ ...checks, tgl })}
            />
            <Check label="Locked" checked disabled onChange={() => undefined} />
            <Check kind="switch" label="Locked" checked={false} disabled onChange={() => undefined} />
          </Row>
        </Section>

        <Section title="Seg · Tabs · FChip">
          <Row label="segments">
            <Seg label="Mode">
              {[
                ['active', 'Active', 4],
                ['all', 'All', 1312],
                ['mine', 'Mine', 0],
              ].map(([key, label, n]) => (
                <SegItem key={key} label={label} n={n} sel={seg === key} onClick={() => setSeg(String(key))} />
              ))}
            </Seg>
          </Row>
          <Row label="tabs">
            <div style={{ width: '100%' }}>
              <Tabs label="Schedule">
                <Tab label="Tasks" n={7} sel={tab === 'tasks'} onClick={() => setTab('tasks')} />
                <Tab label="Runs" n={128} sel={tab === 'runs'} onClick={() => setTab('runs')} />
                <Tab label="Settings" sel={tab === 'settings'} onClick={() => setTab('settings')} />
              </Tabs>
            </div>
          </Row>
          <Row label="filter chips: empty · value · picker">
            <FChip label="Add filter" />
            <FChip label="Agent" value="engineer" />
            <FChip label="Project" value="balabash" icon="folder" end="chevron-down" />
          </Row>
        </Section>

        <Section title="Crumbs">
          <Row label="plain · with lead · file area header">
            <Crumbs
              items={[
                { label: 'Files', href: '#' },
                { label: 'balabash', href: '#' },
              ]}
              current="design"
            />
            <Crumbs lead="folder" items={[{ label: 'renovation', href: '#' }]} current="estimates" />
          </Row>
          <div className="dev-box" style={{ width: 280, padding: 'var(--sp-2)' }}>
            <Crumbs
              fa
              items={[
                { label: 'Files', href: '#' },
                { label: 'balabash', href: '#' },
                { label: 'design', href: '#' },
              ]}
              current="a-very-long-file-name-that-does-not-fit.md"
            />
          </div>
        </Section>

        <Section title="Badge · Status">
          <Row label="badge: six states · sm">
            {STATES.map(state => (
              <Badge key={state} state={state} label={STATE_LABEL[state]} />
            ))}
            <Badge state="run" label="running" size="sm" />
          </Row>
          <Row label="status: six states · custom icon">
            {STATES.map(state => (
              <Status key={state} state={state} label={STATE_LABEL[state]} />
            ))}
            <Status state="wait" icon="clock-alert" label="overdue" />
          </Row>
          <div className="dev-box" style={{ width: 320 }}>
            <List>
              <ThreadRow
                agent="engineer"
                title="Narrow list: badges go compact"
                project="Balabash"
                state="run"
                time="since 14:02"
                href="#"
                onClick={stop}
              />
              <ThreadRow agent="browser" title="Checking /p/kcal" project="Balabash" state="off" time="23:10 → 23:14" href="#" onClick={stop} />
            </List>
          </div>
        </Section>

        <Section title="Avatar">
          <Row label="the catalog, plus an unknown agent">
            {AGENTS.map(agent => (
              <Avatar key={agent} agent={agent} />
            ))}
            <Avatar agent="translator" />
          </Row>
          <Row label="xs · sm · default · lg · pips run / wait / act / err">
            <Avatar agent="engineer" size="xs" />
            <Avatar agent="engineer" size="sm" />
            <Avatar agent="engineer" />
            <Avatar agent="engineer" size="lg" />
            <Avatar agent="coordinator" pip="run" />
            <Avatar agent="designer" pip="wait" />
            <Avatar agent="browser" pip="act" />
            <Avatar agent="codex" pip="err" />
          </Row>
        </Section>

        <Section title="Ring · Ctx · Gauge · Prog">
          <Row label="ring 20 · 62 · 85 · 100 · 130 · lg">
            <Ring value={20} />
            <Ring value={62} />
            <Ring value={85} />
            <Ring value={100} />
            <Ring value={130} />
            <Ring value={62} size="lg" />
          </Row>
          <Row label="ctx: plain · with tokens (hover for the tooltip) · custom text">
            <Ctx percentage={62} />
            <Ctx percentage={41} usedTokens={82_000} maxTokens={200_000} />
            <Ctx percentage={91} usedTokens={182_000} maxTokens={200_000} text="182k" />
          </Row>
          <Row label="gauge 47 · 84 · 100">
            <Gauge value={47} />
            <Gauge value={84} />
            <Gauge value={100} />
          </Row>
          <Row label="progress 62 · err · indeterminate">
            <div style={{ width: 200 }}>
              <Prog value={62} label="Uploading" />
            </div>
            <div style={{ width: 200 }}>
              <Prog value={38} state="err" label="Upload failed" />
            </div>
            <div style={{ width: 200 }}>
              <Prog indeterminate label="Working" />
            </div>
          </Row>
          <Row label="tooltip · hint on focus">
            <Tip>
              Context fill: 124k of 200k<Kbd>C</Kbd>
            </Tip>
            <Hint label="Focus or hover to see the tip">
              <Tag>hover me</Tag>
              <Tip hint>
                A tip <b>adds</b>, it doesn’t hide
              </Tip>
            </Hint>
          </Row>
        </Section>

        <Section title="Card · CardHead · List">
          <div className="dev-grid" data-wide="">
            <Card>
              <CardHead
                title="Active threads"
                count={4}
                countState="run"
                link={<ActionLink label="All threads" href="#" onClick={event => event.preventDefault()} />}
              />
              <List timeW="96px">
                <ListGroup end="7 threads">Today, October 8</ListGroup>
                <ThreadRow
                  agent="engineer"
                  title="Mini-apps: publishing by slug"
                  project="Balabash"
                  lastCode="Read src/api/apps.ts"
                  state="run"
                  time="since 14:02"
                  href="#"
                  onClick={stop}
                  fresh
                />
                <ThreadRow agent="coordinator" title="Sort contractor emails" project="Renovation" state="wait" time="16:42" href="#" onClick={stop} />
                <ListGroup end="5 threads">Yesterday, October 7</ListGroup>
                <ThreadRow
                  agent="browser"
                  title="Checking /p/kcal in the browser"
                  project="Balabash"
                  state="err"
                  time="23:10 → 23:14"
                  href="#"
                  onClick={stop}
                />
                <LoadMore>Loading earlier · showing 12 of 1,312</LoadMore>
              </List>
            </Card>
            <Card>
              <CardHead title="Loading" tag="skeleton">
                <IconBtn icon="refresh-cw" label="Refresh" size="sm" />
              </CardHead>
              <List busy>
                <SkelRow widths={[62, 38]} />
                <SkelRow widths={[48, 30]} />
                <SkelRow widths={[55, 35, 80]} pill={false} />
              </List>
              <CardFoot>
                <Caption>skeleton stack alone:</Caption>
                <div style={{ flex: 1 }}>
                  <SkelStack widths={[70, 40]} smFirst />
                </div>
              </CardFoot>
            </Card>
            <Card narrow="bare">
              <CardHead title="Bare on the phone" count={2} />
              <List narrow="tiles">
                <ThreadRow
                  agent="gardener"
                  title="Rows become tiles on the phone"
                  project="Balabash"
                  state="done"
                  time="12:40 → 12:52"
                  href="#"
                  onClick={stop}
                />
                <ThreadRow
                  agent="scheduler"
                  title="A card without a frame when the shell is narrow"
                  state="wait"
                  time="09:00"
                  href="#"
                  onClick={stop}
                />
              </List>
              <CardBody>
                <Quiet>card body at the gutter edge</Quiet>
              </CardBody>
            </Card>
          </div>
        </Section>

        <Section title="PageHead">
          <PageHead
            title="Renovation"
            desc="Apartment on Petrogradsky: estimate, contractors, work schedule."
            slug="renovation/"
            created="created Aug 14"
            work="active 7 min ago"
            onMore={() => setMenu(open => !open)}
            moreExpanded={menu}
          >
            <Btn label="Edit" icon="pencil" />
            <Btn label="New thread" icon="plus" variant="primary" />
          </PageHead>
          <PageHead
            title="Old kitchen"
            desc="Archived project: nothing runs here."
            slug="kitchen/"
            created="created Mar 2"
            archived
          />
        </Section>

        <Section title="Note">
          <div className="dev-col">
            <Note role="alert" state="err" icon="database" action="Retry now" actionVariant="ghost">
              Database unavailable. Retrying in 8s.
            </Note>
            <Note state="act" icon="message-circle-question">
              The agent is waiting for your reply — a 2FA confirmation code.
            </Note>
            <Note state="wait" icon="hourglass">
              Restart requested: waiting for 2 threads to close.
            </Note>
            <Note state="off" icon="archive">
              This project is archived.
            </Note>
            <Note>File is over 2 MB — no preview, download only.</Note>
          </div>
        </Section>

        <Section title="Menu">
          <Row label="menu · anchored at a “⋯” button (opens on click)">
            <Menu label="Thread">
              <MenuLabel>Thread</MenuLabel>
              <MenuItem icon="pause" label="Stop turn">
                <Kbd>⌘</Kbd>
                <Kbd>.</Kbd>
              </MenuItem>
              <MenuItem icon="git-fork" label="Parent thread" />
              <MenuItem icon="link" label="Copy link" />
              <MenuSep />
              <MenuLabel>Show</MenuLabel>
              <MenuItem icon="brain" label="Thinking" checked />
              <MenuItem icon="wrench" label="Messages only" checked={false} />
              <MenuSep />
              <MenuItem icon="circle-stop" label="Cancel thread" variant="danger" />
            </Menu>
            <MenuAnchor
              open={menu}
              onClose={() => setMenu(false)}
              menu={
                <Menu label="More">
                  <MenuItem icon="pencil" label="Edit" onClick={() => setMenu(false)} />
                  <MenuItem icon="archive" label="Archive" onClick={() => setMenu(false)} />
                  <MenuSep />
                  <MenuItem icon="trash-2" label="Delete" variant="danger" onClick={() => setMenu(false)} />
                </Menu>
              }
            >
              <IconBtn
                icon="ellipsis"
                label="More"
                variant="regular"
                expanded={menu}
                onClick={() => setMenu(open => !open)}
              />
            </MenuAnchor>
          </Row>
          <Row label="anchored in a short card: the menu floats over the card’s edge">
            <Card label="Short card">
              <CardHead title="DB backup" tag="command">
                <Btn label="Run now" icon="play" size="sm" />
                <MenuAnchor
                  open={cardMenu}
                  onClose={() => setCardMenu(false)}
                  menu={
                    <Menu label="Task actions">
                      <MenuItem icon="pencil" label="Edit" onClick={() => setCardMenu(false)} />
                      <MenuItem icon="pause" label="Pause" onClick={() => setCardMenu(false)} />
                      <MenuSep />
                      <MenuItem
                        icon="trash-2"
                        label="Delete task"
                        variant="danger"
                        onClick={() => setCardMenu(false)}
                      />
                    </Menu>
                  }
                >
                  <IconBtn
                    icon="ellipsis"
                    label="Task actions"
                    size="sm"
                    expanded={cardMenu}
                    onClick={() => setCardMenu(open => !open)}
                  />
                </MenuAnchor>
              </CardHead>
              <CardBody>
                <Quiet>pg_dump to file storage, keep 14 copies</Quiet>
              </CardBody>
            </Card>
          </Row>
        </Section>

        <Section title="Modal · Sheet">
          <Row label="bare window (showcase) · open the real ones">
            <Modal
              bare
              title="Cancel thread?"
              cancel="Keep running"
              confirm="Cancel thread"
              confirmVariant="danger"
              onClose={() => undefined}
            >
              The “engineer” agent will stop and the thread will end without a summary. Child threads (2) will be
              cancelled too. This can’t be undone.
            </Modal>
          </Row>
          <Row>
            <Btn label="Open modal" onClick={() => setOverlay('modal')} />
            <Btn label="Open form modal" onClick={() => setOverlay('form')} />
            <Btn label="Open sheet" onClick={() => setOverlay('sheet')} />
            <Btn label="Open form dialog (by shell width)" onClick={() => setOverlay('dialog')} />
          </Row>
          {overlay === 'modal' ? (
            <Modal
              title="Cancel thread?"
              cancel="Keep running"
              confirm="Cancel thread"
              confirmVariant="danger"
              onClose={() => setOverlay(null)}
              onConfirm={() => setOverlay(null)}
            >
              The “engineer” agent will stop and the thread will end without a summary. This can’t be undone.
            </Modal>
          ) : null}
          {overlay === 'form' ? (
            <Modal title="New project" confirm="Create project" form="dev-form" onClose={() => setOverlay(null)}>
              <form
                id="dev-form"
                className="form"
                onSubmit={event => {
                  event.preventDefault();
                  setOverlay(null);
                }}
              >
                <Field label="Name" fid="dev-m-name">
                  <Input id="dev-m-name" value={text} onChange={setText} autoFocus />
                </Field>
                <Field label="Folder" fid="dev-m-slug" hint="Can’t be changed after creation.">
                  <Input id="dev-m-slug" value="bathroom-renovation" onChange={() => undefined} pre="~/" mono />
                </Field>
              </form>
            </Modal>
          ) : null}
          {overlay === 'dialog' ? (
            <Dialog title="New project" confirm="Create project" confirmIcon="plus" form="dev-dialog-form" onClose={() => setOverlay(null)}>
              <form
                id="dev-dialog-form"
                className="form"
                onSubmit={event => {
                  event.preventDefault();
                  setOverlay(null);
                }}
              >
                <Field label="Name" fid="dev-d-name">
                  <Input id="dev-d-name" value={text} onChange={setText} autoFocus />
                </Field>
                <Field label="Folder" fid="dev-d-slug" hint="Can’t be changed after creation.">
                  <Input id="dev-d-slug" value="bathroom-renovation" onChange={() => undefined} pre="~/" mono />
                </Field>
              </form>
            </Dialog>
          ) : null}
          {overlay === 'sheet' ? (
            <Sheet
              label="Cancel thread?"
              title="Cancel thread?"
              desc="The agent will stop and the thread will end without a summary."
              confirm="Cancel thread"
              confirmVariant="danger"
              cancel="Keep running"
              onConfirm={() => setOverlay(null)}
              onClose={() => setOverlay(null)}
            />
          ) : null}
        </Section>

        <Section title="Toast">
          <div className="dev-col">
            {toasts.includes(1) ? (
              <Toast state="done" title="Saved" onClose={() => setToasts(toasts.filter(id => id !== 1))}>
                <Code>balabash/inbox.md</Code>
              </Toast>
            ) : null}
            {toasts.includes(2) ? (
              <Toast
                state="err"
                icon="circle-alert"
                title="Task didn’t start"
                action="Retry"
                action2="Log"
                onClose={() => setToasts(toasts.filter(id => id !== 2))}
              >
                “DB backup”: the command exited with code 127.
              </Toast>
            ) : null}
            {toasts.includes(3) ? (
              <Toast
                state="act"
                icon="key-round"
                title="Sign-in required"
                action="Reconnect"
                onClose={() => setToasts(toasts.filter(id => id !== 3))}
              >
                Gmail · loysagienn — token revoked.
              </Toast>
            ) : null}
            {toasts.includes(4) ? (
              <Toast state="run" icon="upload" title="Uploading 3 files" progress={62}>
                to <Code>renovation/estimates</Code> · 2.1 of 3.4 MB
              </Toast>
            ) : null}
            {toasts.length < 4 ? (
              <Btn label="Restore toasts" size="sm" onClick={() => setToasts([1, 2, 3, 4])} />
            ) : null}
          </div>
        </Section>

        <Section title="Confirm: a Modal in a wide shell, a Sheet in a narrow one · toasts of the store stack in the corner of the shell">
          <Row>
            <Btn label="Cancel thread…" variant="danger" icon="trash-2" onClick={() => setConfirm(true)} />
            <Btn label="Toast: saved" onClick={() => dispatch(pushToast({ state: 'done', title: 'Saved', desc: 'balabash/inbox.md' }))} />
            <Btn label="Toast: error (stays)" onClick={() => dispatch(pushToast({ state: 'err', title: 'Task didn’t start', desc: '“DB backup”: the command exited with code 127.' }))} />
            <Btn label="Toast: plain" onClick={() => dispatch(pushToast({ title: 'Copied', desc: 'The path is in the clipboard.' }))} />
          </Row>
          {confirm ? (
            <Confirm title="Cancel thread?" confirm="Cancel thread" cancel="Keep running" onConfirm={() => setConfirm(false)} onClose={() => setConfirm(false)}>
              The “engineer” agent will stop and the thread will end without a summary. This can’t be undone.
            </Confirm>
          ) : null}
        </Section>

        <Section title="ErrorBoundary: a render that throws becomes the Crashed card; reload to come back">
          <Row>
            <Btn label="Throw in render" variant="danger" icon="triangle-alert" onClick={() => setCrash(true)} />
            {crash ? <Boom /> : null}
          </Row>
        </Section>

        <DevUiShell />
        <DevUiSections />
        <DevUiFiles />
        <DevUiFeed />
      </Screen>
    </Shell>
  );
}
