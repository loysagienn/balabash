// Settings (design: SettingsScreen): the cards "Workspace" (its name) and
// "You" (the operator's name), each saving on its own through
// PATCH /api/settings — the answer updates `me`, so the sidebar and the
// feed follow, and a toast confirms; the cards of facts read by place from
// GET /api/settings (queries.ts; the words — SettingsScreen.logic.ts):
// "Telegram" — the group bound to the workspace, or that none is;
// "Schedule time zone" — the zone the server evaluates cron in, read-only
// (it is the server's environment, SCHEDULE_TIMEZONE); "Session" — this
// browser's row (when it signed in, which browser, how the code came) and
// two actions on this browser: "Reload page" — a plain location.reload()
// (Vladimir's 29000: the installed app has no address bar to reload from;
// it is not a restart of the server) — and the way out.

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { SettingsFactsResponse, TelegramView } from '../../../api/contract.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { logout, saveSettings } from '../../store/session/actions.ts';
import { selectMe, selectSession, selectSettingsSaved, selectSettingsSaving } from '../../store/session/selectors.ts';
import type { SettingsField } from '../../store/session/reducer.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { useNow } from '../../lib/format/useNow.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Card, CardBody, CardFoot, CardHead } from '../../ui/Card/Card.tsx';
import { Caption, Code } from '../../ui/atoms/atoms.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { List, Row } from '../../ui/List/List.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Obj } from '../../ui/Obj/Obj.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { SkelRow, SkelStack } from '../../ui/Skel/Skel.tsx';
import { Status } from '../../ui/Status/Status.tsx';
import { useSettingsFacts } from './queries.ts';
import { factsStage } from '../../lib/query/stage.ts';
import type { FactsStage } from '../../lib/query/stage.ts';
import { sessionWords, telegramWords, timezoneWords } from './SettingsScreen.logic.ts';
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
};

// The input is a draft over the effective value: null — no edits, the input
// shows `current` and follows it. Save sends the draft as it is; once the
// server accepts it (`saved` moves) the draft is dropped, so the input shows
// the effective value — trimmed, or the fallback after clearing — even when
// that value equals the previous one. A draft edited after Save stays: it is
// not what was sent. A failed save leaves the draft for another try.
function NameCard({ title, label, fid, hint, field, current, saving, saved, onSave }: NameCardProps) {
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
      Couldn’t refresh the Telegram binding, the time zone and the session — showing the facts loaded before. {error.message}
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
        <Caption>
          {telegram.enabled ? 'The coordinator posts here and takes your messages.' : 'Remembered, but not served: the server has no bot token.'}
          {telegram.botUsername ? (
            <>
              {' The bot is '}
              <Code>@{telegram.botUsername}</Code>.
            </>
          ) : null}
        </Caption>
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

function SessionCard({ facts, stage, now, logoutPending, onLogout }: { facts: Facts; stage: Stage; now: Date; logoutPending: boolean; onLogout: () => void }) {
  return (
    <Card narrow="bare" label="Session" className="set-session">
      <CardHead title="Session" />
      {stage.kind === 'facts' ? (
        <List narrow="tiles">
          <Row lead={<Obj icon="monitor" size="md" />} title="This browser" meta={sessionWords(stage.data.session, now)} />
        </List>
      ) : stage.kind === 'failed' ? (
        <CardBody>
          <FactsFailure facts={facts} error={stage.error} what="this browser’s session" />
        </CardBody>
      ) : (
        <List narrow="tiles" busy>
          <SkelRow widths={[32, 80]} pill={false} />
        </List>
      )}
      <CardBody>
        <div className="set-act">
          <Caption>Reloads the console in this tab — the way to pick up a newly published build in the installed app. The server keeps running.</Caption>
          <Btn label="Reload page" icon="refresh-cw" onClick={() => window.location.reload()} />
        </div>
        <div className="set-act">
          <Caption>Signs this browser out of the console.</Caption>
          <Btn label="Sign out" icon="log-out" busy={logoutPending} onClick={onLogout} />
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
  const stage = factsStage(facts);
  const now = useNow();

  return (
    <Shell current="settings" title="Settings">
      <Screen>
        <div className="set-col">
          <NameCard
            title="Workspace"
            label="Name"
            fid="ws-n"
            hint="Shown at the top of the sidebar."
            field="workspaceName"
            current={me?.workspaceName ?? null}
            saving={saving.workspaceName}
            saved={saved.workspaceName}
            onSave={value => dispatch(saveSettings({ workspaceName: value }))}
          />
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
          {stage.kind === 'facts' && stage.stale ? <FactsStale facts={facts} error={stage.stale} /> : null}
          <TelegramCard facts={facts} stage={stage} now={now} />
          <TimezoneCard facts={facts} stage={stage} now={now} />
          <SessionCard facts={facts} stage={stage} now={now} logoutPending={logoutPending} onLogout={() => dispatch(logout())} />
        </div>
      </Screen>
    </Shell>
  );
}
