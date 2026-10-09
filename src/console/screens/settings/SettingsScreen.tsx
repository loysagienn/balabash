// Settings (design: SettingsScreen): the cards "Workspace" (its name) and
// "You" (the operator's name), each saving on its own through
// PATCH /api/settings — the answer updates `me`, so the sidebar and the
// feed follow, and a toast confirms; "Session" with the way out. The
// Telegram group and the schedule time zone wait for their data (plan,
// "Чего нет в данных").

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { logout, saveSettings } from '../../store/session/actions.ts';
import { selectMe, selectSession, selectSettingsSaved, selectSettingsSaving } from '../../store/session/selectors.ts';
import type { SettingsField } from '../../store/session/reducer.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Card, CardBody, CardHead } from '../../ui/Card/Card.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
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

export function SettingsScreen() {
  const dispatch = useAppDispatch();
  const me = useAppSelector(selectMe);
  const saving = useAppSelector(selectSettingsSaving);
  const saved = useAppSelector(selectSettingsSaved);
  const { logoutPending } = useAppSelector(selectSession);

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
          <Card narrow="bare" label="Session">
            <CardHead title="Session" />
            <CardBody>
              <Btn label="Sign out" icon="log-out" busy={logoutPending} onClick={() => dispatch(logout())} />
            </CardBody>
          </Card>
        </div>
      </Screen>
    </Shell>
  );
}
