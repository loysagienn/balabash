// "Connect <service>" (the catalog's tile): a sign-in link for a new
// account over CONNECT_SERVICE. One field — the account's name in
// Balabash: the operator's choice for the service's first account (the
// service's name when empty), a must once the service has one (agents
// pick accounts by name). The server's refusal (a name in use, a manual
// OAuth client not provisioned yet, a service of one account) shows in
// the dialog; the dialog closes when the link is answered — the row
// appears pending with "Open sign-in" and the toast says so.

import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import type { ServiceView } from '../../../api/contract.ts';
import { useFormAttempt } from '../../lib/forms/useAttempt.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { connectService } from '../../store/connections/actions.ts';
import { selectServiceConnect } from '../../store/connections/selectors.ts';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { NAME_MAX_LENGTH, nameHint, nameRequired, validateConnectName } from './ConnectionsScreen.logic.ts';

const FORM_ID = 'connect-service';

export function ConnectServiceDialog({ service, accounts, onClose }: { service: ServiceView; accounts: number; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const form = useAppSelector(s => selectServiceConnect(s, service.name));
  const done = useCallback(() => onClose(), [onClose]);
  const attempt = useFormAttempt(form, done);
  const required = nameRequired(service, accounts);
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const err = touched ? validateConnectName(name, required) : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);

    if (attempt.busy || validateConnectName(name, required)) {
      return;
    }

    attempt.begin();
    dispatch(connectService(service.name, name.trim() || null));
  };

  return (
    <Dialog title={`Connect ${service.name}`} confirm="Get sign-in link" confirmIcon="log-in" form={FORM_ID} busy={attempt.busy} onClose={onClose}>
      <form id={FORM_ID} className="form" onSubmit={submit} noValidate>
        {attempt.refusal ? (
          <Note state="err" icon="circle-alert" role="alert">
            {attempt.refusal.message}
          </Note>
        ) : null}
        <Field label="Name in Balabash" fid={`${FORM_ID}-name`} opt={required ? undefined : 'optional'} hint={nameHint(service, accounts)} err={err} required={required}>
          <Input
            id={`${FORM_ID}-name`}
            name="name"
            value={name}
            onChange={value => {
              setName(value);
              attempt.input();
            }}
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            autoFocus
            invalid={Boolean(err)}
          />
        </Field>
        <p className="conn-connect-note">
          You will sign in at {service.name} in a new tab; the account shows up here as connected when you finish.
          {service.manualClient ? ' The service needs Balabash’s own OAuth client credentials in place first — an agent asks for them when they are missing.' : ''}
        </p>
      </form>
    </Dialog>
  );
}
