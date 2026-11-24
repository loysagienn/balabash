// The popup of the toolbar button — the one page the user meets the
// extension on (the design: "15 Browser extension", browser-link/design.md).
// One scroll under a header: the browser's name, the state of the link and
// the pause; a note on what the link is doing when it is not simply up; the
// tab the popup was opened over, to hand it to a session; the sessions
// agents hold in this browser — the ones at work and the idle ones — each
// with the pill of its tab group, its workspace and thread, its tabs and a
// Stop; and the user's limits (boundaries.ts). Everything goes through the
// worker (background.ts).
//
// A popup closes as soon as the user clicks elsewhere, so nothing here is a
// draft: every change of the limits is one action that saves itself — a
// switch, a site added, an entry rewritten, an entry removed — and what the
// worker kept is what is shown. Two actions ask first, in place: a pause
// that would end sessions, and handing tabs over without asking.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../console/styles/index.css';
import { Btn } from '../console/ui/Btn/Btn.tsx';
import { Icon } from '../console/ui/Icon/Icon.tsx';
import type { IconName } from '../console/ui/Icon/Icon.tsx';
import { IconBtn } from '../console/ui/IconBtn/IconBtn.tsx';
import { Input } from '../console/ui/Input/Input.tsx';
import { Status } from '../console/ui/Status/Status.tsx';
import '../console/ui/Check/Check.css';
import '../console/ui/atoms/atoms.css';
import './pages.css';
import { lowerFirst } from './action-look.ts';
import type { Settings, SitesChange } from './boundaries.ts';
import { startOf } from './group-title.ts';
import type { HandRefusal, LinkStatus, SessionView, TabState } from './link.ts';
import { addressParts, ask, hostOf, tabLetter } from './pages.ts';
import { applyStoredTheme } from './theme.ts';

type StateName = 'run' | 'wait' | 'act' | 'paused' | 'done' | 'err' | 'off';

// What the link is, for the words of the popup: `update` — the server takes
// no agent's work through this version; `newer` — it works, a newer is out.
type LinkKind = 'unpaired' | 'connecting' | 'connected' | 'offline' | 'paused' | 'update' | 'newer';

const POLL_MS = 1000;
const SAVED_MS = 2500;
// How much of a thread's title a "Give to" button gets.
const THREAD_IN_BUTTON = 13;

const LINK_WORDS: Record<LinkKind, [state: StateName, text: string]> = {
  unpaired: ['off', 'Not connected'],
  connecting: ['wait', 'Connecting…'],
  connected: ['done', 'Connected'],
  offline: ['err', 'No link — retrying'],
  paused: ['paused', 'Paused'],
  update: ['act', 'Update needed'],
  newer: ['done', 'Connected'],
};

const HAND_REFUSALS: Record<HandRefusal, string> = {
  session_over: 'that session ended meanwhile',
  no_tab: 'the tab is closed',
  blocked_site: 'its site is on your blocked list',
  not_debuggable: 'Chrome’s own pages can’t be given to anyone',
  owned: 'it is another session’s tab already',
};

const UPDATE_STEPS = 'on Connections, unzip it over this extension’s folder and press Reload on chrome://extensions.';

function linkKind(status: LinkStatus): LinkKind {
  if (status.state === 'unpaired' || status.state === 'paused') {
    return status.state;
  }

  if (status.update === 'needed') {
    return 'update';
  }

  return status.state === 'connected' && status.update === 'available' ? 'newer' : status.state;
}

type LinkNote = { state?: StateName; icon: IconName; spin?: boolean; title: string; text: string; action?: string };

function linkNote(kind: LinkKind, status: LinkStatus): LinkNote | null {
  const newer = status.serverVersion || 'the new one';

  switch (kind) {
    case 'unpaired':
      return {
        state: 'act',
        icon: 'plug',
        title: 'Not connected yet',
        text: 'Open Connections in the console in this Chrome and press “Connect this browser”. Your limits below apply from the start.',
        action: 'Open Connections',
      };
    case 'connecting':
      return { state: 'wait', icon: 'loader-circle', spin: true, title: 'Connecting…', text: `Reaching ${hostOf(__CONSOLE_ORIGIN__)}.` };
    case 'offline':
      return {
        state: 'err',
        icon: 'wifi-off',
        title: 'No link to the server — retrying',
        text: `${status.detail ? `Last try: ${lowerFirst(status.detail)}. ` : ''}Agents can’t reach this browser until the link is back.`,
      };
    case 'paused':
      return { state: 'wait', icon: 'pause', title: 'Paused', text: 'The server can’t reach this browser, so no agent works here. Resume to let agents in again.' };
    case 'newer':
      return { icon: 'circle-arrow-up', title: `${status.serverVersion} is out`, text: `This one keeps working. Get the new one ${UPDATE_STEPS}` };
    case 'update':
      return {
        state: 'act',
        icon: 'circle-arrow-up',
        title: 'Update needed',
        text: `The server no longer accepts ${status.version}. Get ${newer} ${UPDATE_STEPS}`,
        action: 'Open Connections',
      };
    default:
      return null;
  }
}

function openConsole(path: string): void {
  void chrome.tabs.create({ url: `${__CONSOLE_ORIGIN__}${path}` });
  window.close();
}

// The tab the popup was opened over.
async function tabInFront(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  return tab;
}

type Shown = {
  status: LinkStatus;
  // Every tab of the browser by its id: the sessions' tabs are named from it.
  tabs: Map<number, chrome.tabs.Tab>;
  front: { tab: chrome.tabs.Tab; state: TabState } | null;
};

async function read(): Promise<Shown | undefined> {
  const status = await ask({ type: 'status' });

  if (!status) {
    return undefined;
  }

  const tabs = new Map((await chrome.tabs.query({})).flatMap(tab => (tab.id === undefined ? [] : [[tab.id, tab] as const])));
  const tab = await tabInFront();
  const state = tab?.id === undefined ? undefined : await ask({ type: 'tabState', tabId: tab.id });

  return { status, tabs, front: tab && state ? { tab, state } : null };
}

function ErrLine({ children }: { children: ReactNode }) {
  return (
    <span className="errline" role="alert">
      <Icon name="circle-x" />
      <span>{children}</span>
    </span>
  );
}

function Fav({ tab }: { tab: { title?: string; url?: string } }) {
  return (
    <span className="ext-fav" aria-hidden="true">
      {tabLetter(tab.title, tab.url)}
    </span>
  );
}

function ThisTab({ front, sessions, onGiven }: { front: NonNullable<Shown['front']>; sessions: SessionView[]; onGiven: () => void }) {
  const { tab, state } = front;
  const [refusal, setRefusal] = useState<string | null>(null);
  const address = addressParts(tab.url ?? tab.pendingUrl);
  const owner = state.state === 'owned' ? sessions.find(session => session.id === state.sessionId) : undefined;

  const give = (session: SessionView) => {
    setRefusal(null);
    void ask({ type: 'handTab', sessionId: session.id, tabId: tab.id! }).then(answer => {
      if (answer?.ok) {
        onGiven();
      } else {
        setRefusal(answer?.code ? HAND_REFUSALS[answer.code] : (answer?.error ?? 'the extension did not answer'));
      }
    });
  };

  return (
    <div className="ext-sec">
      <div className="ext-sec-h">
        <b>This tab</b>
      </div>
      <div className="ext-tab">
        <Fav tab={tab} />
        <span className="ext-tab-t">{tab.title || '(untitled)'}</span>
        <span className="ext-tab-u">
          {address.host}
          {address.path}
        </span>
        {state.state === 'free' ? (
          <div className="ext-tab-a">
            <span className="quiet">Give to</span>
            {sessions.map(session => (
              <Btn
                key={session.id}
                size="sm"
                title={session.thread}
                label={
                  <>
                    <span className="grp-dot" data-c={session.group.color} />
                    {startOf(session.thread, THREAD_IN_BUTTON) || `session ${session.id}`}
                  </>
                }
                onClick={() => give(session)}
              />
            ))}
          </div>
        ) : null}
        {refusal ? (
          <div className="ext-tab-a">
            <ErrLine>Couldn’t give the tab: {refusal}.</ErrLine>
          </div>
        ) : null}
        {owner ? (
          <div className="ext-tab-a ext-tab-own">
            <span>In the group of</span>
            <span className="grp" data-c={owner.group.color}>
              {owner.group.title}
            </span>
            <span className="quiet">Drag it out of the group to take it back.</span>
          </div>
        ) : null}
        {state.state === 'blocked' || state.state === 'closed' ? (
          <div className="ext-tab-a">
            <span className="ext-why">
              <Icon name={state.state === 'blocked' ? 'ban' : 'info'} />
              {state.state === 'blocked' ? `${state.site} is on your blocked list — no agent can get this tab.` : 'Chrome’s own pages can’t be given to anyone.'}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Session({ session, tabs, alone, onStop }: { session: SessionView; tabs: Shown['tabs']; alone: boolean; onStop: () => void }) {
  // A lone working session shows its tabs; the user's click decides after that.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (alone && !session.parked);
  const count = session.tabIds.length;

  return (
    <div className="ext-s" data-c={session.group.color} data-session={session.id} data-parked={session.parked ? 'true' : 'false'}>
      <div className="ext-s-top">
        <span className="grp" data-c={session.group.color}>
          {session.group.title}
        </span>
        <Status state={session.parked ? 'paused' : 'run'} label={session.parked ? 'idle' : 'working'} />
      </div>
      <div className="ext-s-l">
        {session.workspace ? <span className="ext-ws">{session.workspace} · </span> : null}
        {session.thread || session.label}
      </div>
      <div className="ext-s-f">
        <button type="button" className="ext-s-n" aria-expanded={open ? 'true' : 'false'} onClick={() => setToggled(!open)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          {count} {count === 1 ? 'tab' : 'tabs'}
        </button>
        <Btn label="Stop" icon="square" size="sm" onClick={onStop} />
      </div>
      {session.parked ? <div className="ext-s-idle">Idle: no tab is being driven now. It comes back to these tabs on its own when it continues.</div> : null}
      {open && count > 0 ? (
        <ul className="ext-s-tabs">
          {session.tabIds.map(tabId => {
            const tab = tabs.get(tabId);

            return (
              <li key={tabId}>
                <Fav tab={tab ?? {}} />
                <span>{tab?.title || '(untitled)'}</span>
                <span className="quiet">{hostOf(tab?.url ?? tab?.pendingUrl)}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function Sites({ sites, change }: { sites: string[]; change: (change: SitesChange) => Promise<boolean> }) {
  const [adding, setAdding] = useState('');
  const [addInvalid, setAddInvalid] = useState(false);
  const [editing, setEditing] = useState<{ site: string; text: string; invalid: boolean } | null>(null);

  const add = (event: FormEvent) => {
    event.preventDefault();

    if (!adding.trim()) {
      return;
    }

    void change({ add: adding }).then(kept => {
      setAddInvalid(!kept);

      if (kept) {
        setAdding('');
      }
    });
  };

  const rewrite = (event: FormEvent) => {
    event.preventDefault();

    if (!editing) {
      return;
    }

    if (editing.text.trim() === editing.site) {
      setEditing(null);

      return;
    }

    void change({ replace: editing.site, with: editing.text }).then(kept => setEditing(kept ? null : { ...editing, invalid: true }));
  };

  const leaveOnEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      setEditing(null);
    }
  };

  return (
    <div>
      <div className="ext-opt-t ext-sites-h">Blocked sites · {sites.length}</div>
      <div className="ext-opt-d ext-sites-d">Agents never open them, don’t see their tabs and can’t get them; an agent’s tab that goes there is taken back. Subdomains included.</div>
      {sites.length > 0 ? (
        <div className="ext-sites">
          {sites.map(site =>
            editing?.site === site ? (
              <form key={site} className="ext-site" data-edit="" onSubmit={rewrite} onKeyDown={leaveOnEscape}>
                <Input value={editing.text} onChange={text => setEditing({ site, text, invalid: false })} mono autoFocus invalid={editing.invalid} ariaLabel={`Blocked site ${site}`} spellCheck={false} autoComplete="off" />
                <Btn label="Save" size="sm" type="submit" />
              </form>
            ) : (
              <div key={site} className="ext-site" data-site={site}>
                <span>{site}</span>
                <span className="ext-site-a">
                  <IconBtn icon="pencil" label={`Edit ${site}`} size="sm" onClick={() => setEditing({ site, text: site, invalid: false })} />
                  <IconBtn icon="x" label={`Remove ${site}`} size="sm" onClick={() => void change({ remove: site })} />
                </span>
              </div>
            ),
          )}
        </div>
      ) : null}
      <form className="ext-add" onSubmit={add}>
        <Input
          value={adding}
          onChange={text => {
            setAdding(text);
            setAddInvalid(false);
          }}
          placeholder="example.com"
          mono
          invalid={addInvalid}
          ariaLabel="A site to block"
          spellCheck={false}
          autoComplete="off"
        />
        <Btn label="Add" icon="plus" size="sm" type="submit" />
      </form>
      <div className="ext-opt-d ext-sites-n">A pasted address keeps only its domain. Not caught: a blocked site shown inside another page as a frame.</div>
    </div>
  );
}

// What the last change of the limits came to: kept, or not — a switch or the list of sites.
type SaveMark = 'saved' | 'switch-failed' | 'sites-failed' | null;

function Limits({ settings, onSettings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const [mark, setMark] = useState<SaveMark>(null);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const settled = (kept: Settings | undefined, what: 'switch' | 'sites'): boolean => {
    clearTimeout(timer.current);
    setMark(kept ? 'saved' : `${what}-failed`);

    if (kept) {
      onSettings(kept);
      timer.current = setTimeout(() => setMark(null), SAVED_MS);
    }

    return Boolean(kept);
  };

  const setSwitch = (change: { tabsListHidden: boolean } | { tabsWithoutAsking: boolean }) => void ask({ type: 'setSwitches', ...change }).then(kept => settled(kept, 'switch'));

  // False when the entry names no site: the field says so, nothing failed.
  const changeSites = async (change: SitesChange): Promise<boolean> => {
    const answer = await ask({ type: 'changeSites', change });

    if (answer && !answer.ok) {
      return false;
    }

    return settled(answer?.settings, 'sites');
  };

  return (
    <div className="ext-sec">
      <div className="ext-sec-h">
        <b>Limits</b>
        {mark === 'saved' ? (
          <span className="ext-saved" role="status">
            <Icon name="check" />
            Saved
          </span>
        ) : null}
      </div>
      <div className="ext-set">
        <label className="ext-opt">
          <span className="ext-opt-t">Agents see my tab list</span>
          <span className="ext-opt-d">Titles and addresses of your open tabs, not what’s in them. Blocked sites are left out.</span>
          <input className="tgl" type="checkbox" role="switch" id="tabs-list" checked={!settings.tabsListHidden} onChange={event => setSwitch({ tabsListHidden: !event.target.checked })} />
        </label>
        {mark === 'switch-failed' ? <ErrLine>Couldn’t save — the switch is back as it was. Try again.</ErrLine> : null}
        <label className="ext-opt">
          <span className="ext-opt-t">Hand over tabs without asking</span>
          <span className="ext-opt-d">
            {settings.tabsWithoutAsking ? 'On: a tab an agent asks for is its tab at once. Blocked sites stay closed.' : 'Off: a window asks you each time an agent wants one of your tabs.'}
          </span>
          <input
            className="tgl"
            type="checkbox"
            role="switch"
            id="without-asking"
            checked={settings.tabsWithoutAsking}
            onChange={event => {
              if (event.target.checked) {
                setConfirming(true);
              } else {
                setConfirming(false);
                setSwitch({ tabsWithoutAsking: false });
              }
            }}
          />
        </label>
        {confirming && !settings.tabsWithoutAsking ? (
          <div className="ext-confirm">
            <b>Stop asking before a tab goes to an agent?</b>
            <span>Any tab an agent asks for becomes its tab at once, with no window to say no. Blocked sites stay closed.</span>
            <span className="ext-confirm-a">
              <Btn
                label="Stop asking"
                variant="danger"
                size="sm"
                onClick={() => {
                  setConfirming(false);
                  setSwitch({ tabsWithoutAsking: true });
                }}
              />
              <Btn label="Cancel" variant="ghost" size="sm" onClick={() => setConfirming(false)} />
            </span>
          </div>
        ) : null}
        <Sites sites={settings.blockedSites} change={changeSites} />
        {mark === 'sites-failed' ? <ErrLine>Couldn’t save — the list is as it was. Try again.</ErrLine> : null}
        <div className="ext-never">
          <Icon name="shield-check" />
          <span>Never allowed, whatever the settings: reading your cookies, closing the browser.</span>
        </div>
      </div>
    </div>
  );
}

function Popup() {
  const [shown, setShown] = useState<Shown>();
  const [settings, setSettings] = useState<Settings>();
  const [pauseAsked, setPauseAsked] = useState(false);
  // An answer asked for before a change of the user's would put the popup back.
  const changes = useRef(0);

  const refresh = useCallback(() => {
    const asked = changes.current;

    void read().then(next => {
      if (next && asked === changes.current) {
        setShown(next);
      }
    });
  }, []);

  useEffect(() => {
    refresh();
    void ask({ type: 'getSettings' }).then(kept => kept && setSettings(kept));

    const timer = setInterval(refresh, POLL_MS);

    return () => clearInterval(timer);
  }, [refresh]);

  // The user's own action: what was asked before it is stale.
  const act = (request: Promise<LinkStatus | undefined>) => {
    changes.current += 1;
    void request.then(status => {
      if (status) {
        setShown(before => before && { ...before, status });
      }

      refresh();
    });
  };

  if (!shown) {
    return <div className="ext-pop" aria-busy="true" />;
  }

  const { status, tabs, front } = shown;
  const kind = linkKind(status);
  const live = kind === 'connected' || kind === 'newer';
  const sessions = live ? status.sessions : [];
  const note = linkNote(kind, status);
  const [linkState, linkText] = LINK_WORDS[kind];

  const pause = () => {
    setPauseAsked(false);
    act(ask({ type: 'setPaused', paused: true }));
  };

  return (
    <div className="ext-pop" data-link={kind}>
      <div className="ext-hd">
        <img src="icons/icon-128.png" alt="" />
        <div>
          <div className="ext-hd-t" id="name" title={status.name || undefined}>
            {status.name || 'Balabash Agent'}
          </div>
          <div className="ext-hd-m">
            <Status state={linkState} label={linkText} />
          </div>
        </div>
        {status.state === 'paused' ? (
          <Btn label="Resume" icon="play" variant="primary" size="sm" onClick={() => act(ask({ type: 'setPaused', paused: false }))} />
        ) : (
          <Btn label="Pause" icon="pause" size="sm" disabled={status.state === 'unpaired'} onClick={() => (status.sessions.length > 0 ? setPauseAsked(true) : pause())} />
        )}
      </div>
      {pauseAsked && status.state !== 'paused' ? (
        <div className="ext-pausecf">
          <b>Pause this browser?</b>
          <span>
            The server loses its link to this browser until you resume
            {status.sessions.length > 0
              ? `, and ${status.sessions.length === 1 ? 'the session' : `all ${status.sessions.length} sessions`} here ${status.sessions.length === 1 ? 'ends' : 'end'} now — ${status.sessions.length === 1 ? 'its' : 'their'} tabs stay open as yours.`
              : '; no agent can start here.'}
          </span>
          <span className="ext-confirm-a">
            <Btn label="Pause" icon="pause" variant="danger" size="sm" onClick={pause} />
            <Btn label="Cancel" variant="ghost" size="sm" onClick={() => setPauseAsked(false)} />
          </span>
        </div>
      ) : null}
      {settings?.tabsWithoutAsking ? (
        <div className="ext-warn">
          <Icon name="shield-alert" />
          Tabs go to agents without asking
        </div>
      ) : null}
      <div className="ext-scroll">
        {note ? (
          <div className="ext-sec">
            <div className="ext-note" data-state={note.state}>
              <Icon name={note.icon} spin={note.spin} />
              <div>
                <b>{note.title}</b>
                <span className="ext-note-d">{note.text}</span>
                {note.action ? (
                  <span className="ext-note-a">
                    <Btn label={note.action} icon="arrow-up-right" size="sm" onClick={() => openConsole('/connections')} />
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {live && sessions.length > 0 && front ? <ThisTab key={front.tab.id} front={front} sessions={sessions} onGiven={refresh} /> : null}

        {live ? (
          <div className="ext-sec">
            <div className="ext-sec-h">
              <b>{sessions.length > 0 ? `Sessions · ${sessions.length}` : 'Sessions'}</b>
              {sessions.length > 1 ? <Btn label="Stop all" icon="square" variant="ghost" size="sm" onClick={() => act(ask({ type: 'stopSessions' }))} /> : null}
            </div>
            {sessions.length === 0 ? (
              <p className="ext-empty">No agent is working in this browser. When one starts, its tabs gather in a colored group of their own and it shows up here.</p>
            ) : (
              <>
                <div className="ext-ses">
                  {sessions.map(session => (
                    <Session key={session.id} session={session} tabs={tabs} alone={sessions.length === 1} onStop={() => act(ask({ type: 'stopSessions', sessionId: session.id }))} />
                  ))}
                </div>
                <p className="ext-hint">Drag a tab into a session’s group to give it, out of the group to take it back. Closing Chrome’s “started debugging” bar stops every working session.</p>
              </>
            )}
          </div>
        ) : null}

        {settings ? <Limits settings={settings} onSettings={setSettings} /> : null}
      </div>
      <div className="ext-ft">
        <span>Balabash Agent {status.version}</span>
        <a className="link" id="console" href={`${__CONSOLE_ORIGIN__}/`} target="_blank" rel="noreferrer">
          Open console
          <Icon name="arrow-up-right" />
        </a>
      </div>
    </div>
  );
}

void applyStoredTheme();
createRoot(document.getElementById('root')!).render(<Popup />);
