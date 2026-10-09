// Settings (design: SettingsScreen): the cards "Workspace" (its name) and
// "You" (the operator's name), each saving on its own through
// PATCH /api/settings — the answer updates `me`, so the sidebar and the
// feed follow, and a toast confirms; "Session" with the way out. The
// Telegram group and the schedule time zone wait for their data (plan,
// "Чего нет в данных").

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { logout, saveSettings } from '../../store/session/actions.ts';
import { selectMe, selectSession, selectSettingsSaving } from '../../store/session/selectors.ts';
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
  // The effective value from `me`; the input restarts from it after a save.
  current: string | null;
  saving: boolean;
  onSave: (value: string) => void;
};

function NameCard({ title, label, fid, hint, field, current, saving, onSave }: NameCardProps) {
  const [value, setValue] = useState(current ?? '');

  useEffect(() => {
    setValue(current ?? '');
  }, [current]);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!saving) {
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
              <Input id={fid} name={field} value={value} onChange={setValue} maxLength={NAME_MAX_LENGTH} autoComplete="off" />
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
