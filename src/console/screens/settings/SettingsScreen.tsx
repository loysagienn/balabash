// Settings (design: SettingsScreen): the cards "Workspace" (its name, and
// the color of its mark — this browser's choice, lib/workspace) and "You"
// (the operator's name), each name saving on its own through
// PATCH /api/settings — the answer updates `me`, so the sidebar and the
// feed follow, and a toast confirms; "Appearance" — the color theme, this
// browser's choice (lib/theme), applied on choice; the cards of facts read
// by place from GET /api/settings (queries.ts; the words — SettingsScreen.logic.ts):
// "Telegram" — the group bound to the workspace, or that none is;
// "Schedule time zone" — the zone the server evaluates cron in, read-only
// (it is the server's environment, SCHEDULE_TIMEZONE); "Signed in on this
// browser" — the workspaces of this browser (GET /api/workspaces), the way
// out of this tab's one, one more workspace, and "Reload page".

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import type { SettingsFactsResponse, TelegramView } from '../../../api/contract.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { logout, saveSettings } from '../../store/session/actions.ts';
import { selectMe, selectSession, selectSettingsSaved, selectSettingsSaving } from '../../store/session/selectors.ts';
import type { SettingsField } from '../../store/session/reducer.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { useNow } from '../../lib/format/useNow.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Card, CardBody, CardFoot, CardHead } from '../../ui/Card/Card.tsx';
import { Code, Tag } from '../../ui/atoms/atoms.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Icon } from '../../ui/Icon/Icon.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { List, Row } from '../../ui/List/List.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { SkelRow, SkelStack } from '../../ui/Skel/Skel.tsx';
import { Status } from '../../ui/Status/Status.tsx';
import { WsMark } from '../../ui/WsMark/WsMark.tsx';
import { useWorkspaces } from '../../features/workspaces/queries.ts';
import { WORKSPACE_COLORS, setWorkspaceColor } from '../../lib/workspace/index.ts';
import { DEFAULT_THEME, THEMES, setTheme, subscribeTheme, themeSnapshot } from '../../lib/theme/index.ts';
import type { ThemeId } from '../../lib/theme/index.ts';
import { openAddWorkspace } from '../../store/ui/actions.ts';
import { useSettingsFacts } from './queries.ts';
import { useFactsStage } from '../../lib/query/useFactsStage.ts';
import type { FactsStage } from '../../lib/query/stage.ts';
import { browserWords, telegramWords, timezoneWords, workspaceSessionWords } from './SettingsScreen.logic.ts';
import './SettingsScreen.css';

// A name of Settings: at most this long (the server's cap).
export const NAME_MAX_LENGTH = 100;

type NameCardProps = {
  title: string;
  label: string;
  fid: string;
  hint: string;
  field: SettingsField;
  // The effective value from `me`: what the input shows while it has no draft.
  current: string | null;
  saving: boolean;
  // The count of accepted saves of this field (session.settingsSaved).
  saved: number;
  onSave: (value: string) => void;
  // More of the card under the name (the workspace's color).
  children?: ReactNode;
};

// The input is a draft over the effective value: null — no edits, the input
// shows `current` and follows it. Save sends the draft as it is; once the
// server accepts it (`saved` moves) the draft is dropped, so the input shows
// the effective value — trimmed, or the fallback after clearing — even when
// that value equals the previous one. A draft edited after Save stays: it is
// not what was sent. A failed save leaves the draft for another try.
function NameCard({ title, label, fid, hint, field, current, saving, saved, onSave, children }: NameCardProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const sent = useRef<string | null>(null);
  const value = draft ?? current ?? '';

  useEffect(() => {
    setDraft(pending => (pending === sent.current ? null : pending));
    sent.current = null;
  }, [saved]);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!saving) {
      sent.current = value;
      onSave(value);
    }
  };

  return (
    <Card narrow="bare" label={title}>
      <CardHead title={title} />
      <CardBody>
        <form onSubmit={submit}>
          <Field label={label} fid={fid} hint={hint}>
            <div className="set-inline">
              <Input id={fid} name={field} value={value} onChange={setDraft} maxLength={NAME_MAX_LENGTH} autoComplete="off" />
              <Btn label="Save" type="submit" busy={saving} />
            </div>
          </Field>
        </form>
        {children}
      </CardBody>
    </Card>
  );
}

// The radio groups of buttons (the color swatches, the theme tiles) move
// with the arrow keys like a native radio group: the arrows pick the next or
// previous option and focus it, Home and End the first and the last. The
// group's buttons are its direct children in option order.
function pickWithArrows<T>(event: KeyboardEvent<HTMLElement>, options: readonly T[], current: T, pick: (option: T) => void): void {
  const index = options.indexOf(current);
  let next: number;

  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = (index + 1) % options.length;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      next = (index - 1 + options.length) % options.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = options.length - 1;
      break;
    default:
      return;
  }

  event.preventDefault();
  pick(options[next]!);
  event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}

// The workspace's mark color — this browser's choice (lib/workspace): the
// mark in each of the eight identity colors, saved on choice.
function ColorField({ name, workspaceId, color }: { name: string; workspaceId: string; color: number }) {
  const pick = (option: number) => setWorkspaceColor(workspaceId, option);

  return (
    <div className="fld set-color">
      <span className="fld-l" id="ws-c">
        Color
      </span>
      <div className="set-sws" role="radiogroup" aria-labelledby="ws-c" onKeyDown={event => pickWithArrows(event, WORKSPACE_COLORS, color, pick)}>
        {WORKSPACE_COLORS.map(option => (
          <button key={option} type="button" className="set-sw" role="radio" aria-checked={option === color} tabIndex={option === color ? 0 : -1} aria-label={`Color ${option}`} onClick={() => pick(option)}>
            <WsMark name={name} color={option} />
          </button>
        ))}
      </div>
      <p className="fld-h">Tells this workspace apart from the others signed in on this browser. Kept in this browser, saved on choice.</p>
    </div>
  );
}

// The color theme — this browser's choice (lib/theme): five tiles, each a
// preview drawn in its own theme (data-bb-theme on the preview, Graphite's
// included — its block in themes.css repeats :root, so the preview keeps its
// colors inside a page of another theme), the name and one line under
// it; picking one repaints the whole console at once, this page included.
// The tile's data-scheme (dark / light) picks its span on the phone (the
// CSS). A choice made in another tab shows here too (subscribeTheme).
function ThemePreview({ theme }: { theme: ThemeId }) {
  return (
    <span className="set-theme-pv" data-bb-theme={theme} aria-hidden="true">
      <span className="set-theme-side">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="set-theme-main">
        <span className="set-theme-card">
          <i />
          <i />
          <i />
          <span className="set-theme-ft">
            <i />
            <i />
            <i />
          </span>
        </span>
      </span>
    </span>
  );
}

const THEME_IDS: readonly ThemeId[] = THEMES.map(theme => theme.id);

function AppearanceCard() {
  const current = useSyncExternalStore(subscribeTheme, themeSnapshot, () => DEFAULT_THEME);

  return (
    <Card narrow="bare" label="Appearance">
      <CardHead title="Appearance" />
      <CardBody>
        <div className="fld">
          <span className="fld-l" id="th-l">
            Theme
          </span>
          <div className="set-themes" role="radiogroup" aria-labelledby="th-l" onKeyDown={event => pickWithArrows(event, THEME_IDS, current, setTheme)}>
            {THEMES.map(theme => (
              <button key={theme.id} type="button" className="set-theme" role="radio" aria-checked={theme.id === current} tabIndex={theme.id === current ? 0 : -1} data-scheme={theme.scheme} onClick={() => setTheme(theme.id)}>
                <ThemePreview theme={theme.id} />
                <span className="set-theme-cap">
                  <span className="set-theme-n">{theme.name}</span>
                  {theme.id === current ? <Icon name="check" /> : null}
                </span>
                <span className="set-theme-d">{theme.desc}</span>
              </button>
            ))}
          </div>
          <p className="fld-h">Changes colors only. Kept in this browser, applied on choice.</p>
        </div>
      </CardBody>
    </Card>
  );
}

// The facts of the three cards come from one query; each card shows its
// own stage of it (factsStage) — a skeleton of its shape while the facts
// are in flight, the failure with Retry (a failed read must not look like
// one still going), the facts. A refetch that failed over facts loaded
// before (the tab's return after the server went away) is one note above
// the three cards, with Retry: Query keeps the last good answer, and the
// cards show it, but as what it is — the facts of an earlier moment.
type Facts = ReturnType<typeof useSettingsFacts>;
type Stage = FactsStage<SettingsFactsResponse>;

function FactsFailure({ facts, error, what }: { facts: Facts; error: Error; what: string }) {
  return (
    <Note state="err" role="alert" action="Retry" actionBusy={facts.isFetching} onAction={() => void facts.refetch()}>
      Couldn’t load {what} — {error.message}
    </Note>
  );
}

function FactsStale({ facts, error }: { facts: Facts; error: Error }) {
  return (
    <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" actionBusy={facts.isFetching} onAction={() => void facts.refetch()}>
      Couldn’t refresh the Telegram binding, the time zone and this browser’s session — showing the facts loaded before. {error.message}
    </Note>
  );
}

function TelegramRow({ telegram, now }: { telegram: TelegramView; now: Date }) {
  if (!telegram.group) {
    return (
      <CardBody>
        {telegram.enabled ? (
          <Note state="act" icon="send">
            No Telegram group is linked to this workspace — the coordinator has nowhere to post.
          </Note>
        ) : (
          <Note state="off" icon="send">
            The Telegram channel is off — the server has no bot token. The console is the way to the coordinator.
          </Note>
        )}
      </CardBody>
    );
  }

  const words = telegramWords(telegram.group, now);

  return (
    <>
      <List narrow="tiles">
        <Row
          lead={<Obj icon="send" size="md" />}
          title={words.title}
          meta={
            <>
              {words.kind ? `${words.kind} · ` : null}
              <Code>{words.chatId}</Code>
              {` · ${words.linked}`}
            </>
          }
          end={telegram.enabled ? <Status state="done" label="linked" /> : <Status state="off" label="channel off" />}
        />
      </List>
      <CardFoot>
        <span className="set-note">
          {telegram.enabled ? 'The coordinator posts here and takes your messages.' : 'Remembered, but not served: the server has no bot token.'}
          {telegram.botUsername ? (
            <>
              {' The bot is '}
              <Code>@{telegram.botUsername}</Code>.
            </>
          ) : null}
        </span>
      </CardFoot>
    </>
  );
}

function TelegramCard({ facts, stage, now }: { facts: Facts; stage: Stage; now: Date }) {
  return (
    <Card narrow="bare" label="Telegram">
      <CardHead title="Telegram" />
      {stage.kind === 'facts' ? (
        <TelegramRow telegram={stage.data.telegram} now={now} />
      ) : stage.kind === 'failed' ? (
        <CardBody>
          <FactsFailure facts={facts} error={stage.error} what="the Telegram binding" />
        </CardBody>
      ) : (
        <List narrow="tiles" busy>
          <SkelRow widths={[40, 72]} />
        </List>
      )}
    </Card>
  );
}

function TimezoneCard({ facts, stage, now }: { facts: Facts; stage: Stage; now: Date }) {
  let body: ReactNode;

  if (stage.kind === 'facts') {
    const words = timezoneWords(stage.data.scheduleTimezone, now);

    body = (
      <Field
        label="Time zone"
        fid="tz"
        hint={
          <>
            All cron expressions use this time zone.{words.clock ? ` ${words.clock}` : ''} Set by <Code>SCHEDULE_TIMEZONE</Code> of the server’s environment.
          </>
        }
      >
        <Input id="tz" value={words.value} onChange={() => undefined} readOnly mono ariaLabel="Time zone" />
      </Field>
    );
  } else if (stage.kind === 'failed') {
    body = <FactsFailure facts={facts} error={stage.error} what="the time zone" />;
  } else {
    body = <SkelStack widths={[24, 56]} smFirst />;
  }

  return (
    <Card narrow="bare" label="Schedule time zone">
      <CardHead title="Schedule time zone" />
      <CardBody>{body}</CardBody>
    </Card>
  );
}

// The workspaces this browser is signed in to (features/workspaces): a row
// each — mark, name, "this workspace" on the tab's own, when and how it was
// signed in; "Sign out" on the tab's own (the others are signed out from
// their own tabs). Below: one more workspace, which browser this is, and
// "Reload page" — a plain location.reload() (Vladimir's 29000: the
// installed app has no address bar to reload from; it is not a restart of
// the server).
function BrowserCard({ facts, stage, now, logoutPending, onLogout, onAdd }: { facts: Facts; stage: Stage; now: Date; logoutPending: boolean; onLogout: () => void; onAdd: () => void }) {
  const { items } = useWorkspaces();
  const browser = stage.kind === 'facts' ? browserWords(stage.data.session.userAgent) : null;

  return (
    <Card narrow="bare" label="Signed in on this browser" className="set-session">
      <CardHead title="Signed in on this browser" count={items.length} />
      <List narrow="tiles">
        {items.map(item => {
          // The tab's own workspace without the list (an older server):
          // the facts of the session stand in.
          const own = item.current && item.signedInAt === null && stage.kind === 'facts' ? stage.data.session : null;
          const meta = own ? workspaceSessionWords(own.createdAt, own.loginSource, now) : workspaceSessionWords(item.signedInAt, item.loginSource, now);

          return (
            <Row
              key={item.workspaceId}
              lead={<WsMark name={item.name} color={item.color} />}
              title={item.name}
              tag={item.current ? <Tag>this workspace</Tag> : null}
              meta={meta}
              end={item.current ? <Btn label="Sign out" icon="log-out" size="sm" busy={logoutPending} onClick={onLogout} /> : null}
            />
          );
        })}
      </List>
      {stage.kind === 'failed' ? (
        <CardBody>
          <FactsFailure facts={facts} error={stage.error} what="this browser’s session" />
        </CardBody>
      ) : null}
      <CardBody>
        <div className="set-act">
          <span className="set-note">{browser ? `This browser: ${browser}.` : 'Sign in to one more workspace on this browser with its one-time code.'}</span>
          <Btn label="Sign in to another workspace" icon="plus" onClick={onAdd} />
        </div>
        <div className="set-act">
          <span className="set-note">Reloads the console in this tab — the way to pick up a newly published build in the installed app. The server keeps running.</span>
          <Btn label="Reload page" icon="refresh-cw" onClick={() => window.location.reload()} />
        </div>
      </CardBody>
    </Card>
  );
}

export function SettingsScreen() {
  const dispatch = useAppDispatch();
  const me = useAppSelector(selectMe);
  const saving = useAppSelector(selectSettingsSaving);
  const saved = useAppSelector(selectSettingsSaved);
  const { logoutPending } = useAppSelector(selectSession);
  const facts = useSettingsFacts();
  const stage = useFactsStage(facts);
  const now = useNow();
  const workspace = useWorkspaces();

  return (
    <Shell current="settings" title="Settings">
      <Screen>
        <div className="set-col">
          <NameCard
            title="Workspace"
            label="Name"
            fid="ws-n"
            hint="Shown in the workspace switcher and at the top of the sidebar."
            field="workspaceName"
            current={me?.workspaceName ?? null}
            saving={saving.workspaceName}
            saved={saved.workspaceName}
            onSave={value => dispatch(saveSettings({ workspaceName: value }))}
          >
            {workspace.current ? <ColorField name={workspace.current.name} workspaceId={workspace.current.workspaceId} color={workspace.current.color} /> : null}
          </NameCard>
          <NameCard
            title="You"
            label="Your name"
            fid="op-n"
            hint="Shown under the workspace name and as the author of your messages in threads."
            field="operatorName"
            current={me?.operatorName ?? null}
            saving={saving.operatorName}
            saved={saved.operatorName}
            onSave={value => dispatch(saveSettings({ operatorName: value }))}
          />
          <AppearanceCard />
          {stage.kind === 'facts' && stage.stale ? <FactsStale facts={facts} error={stage.stale} /> : null}
          <TelegramCard facts={facts} stage={stage} now={now} />
          <TimezoneCard facts={facts} stage={stage} now={now} />
          <BrowserCard facts={facts} stage={stage} now={now} logoutPending={logoutPending} onLogout={() => dispatch(logout())} onAdd={() => dispatch(openAddWorkspace())} />
        </div>
      </Screen>
    </Shell>
  );
}
