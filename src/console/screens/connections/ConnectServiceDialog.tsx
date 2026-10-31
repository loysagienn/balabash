// "Connect <service>" (the catalog's tile): a sign-in link for a new
// account over CONNECT_SERVICE. One field — the account's name in
// Balabash: the operator's choice for the service's first account (the
// service's name when empty), a must once the service has one (agents
// pick accounts by name). The server's refusal (a name in use, a manual
// OAuth client not provisioned yet, a service of one account) shows in
// the dialog; the dialog closes when the link is answered — the row
// appears pending with "Open sign-in" and the toast says so.
//
// A service with a manual OAuth client (gmail, drive) has one step before
// the first sign-in: Balabash's own client at the provider. While it is
// missing the dialog says so and its one action is "Provide OAuth client" —
// the server opens a request for it (addressed to the main thread, as the
// auth agent's would be) and the tab goes to the secrets form
// (/secrets/<id>). With the client in place the sign-in link is the
// action, and "Replace OAuth client" at the bottom opens the same form for
// a rotated secret; connected accounts stay.

import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import type { ServiceView } from '../../../api/contract.ts';
import { useApi } from '../../lib/api/context.tsx';
import { toApiFailure } from '../../lib/api/index.ts';
import { useFormAttempt } from '../../lib/forms/useAttempt.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { connectService } from '../../store/connections/actions.ts';
import { selectServiceConnect } from '../../store/connections/selectors.ts';
import { routeTo } from '../../store/router/actions.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { NAME_MAX_LENGTH, clientMissing, nameHint, nameRequired, validateConnectName } from './ConnectionsScreen.logic.ts';

const FORM_ID = 'connect-service';

export function ConnectServiceDialog({ service, accounts, onClose }: { service: ServiceView; accounts: number; onClose: () => void }) {
  const api = useApi();
  const dispatch = useAppDispatch();
  const form = useAppSelector(s => selectServiceConnect(s, service.name));
  const done = useCallback(() => onClose(), [onClose]);
  const attempt = useFormAttempt(form, done);
  const required = nameRequired(service, accounts);
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [clientBusy, setClientBusy] = useState(false);
  const [clientRefusal, setClientRefusal] = useState<string | null>(null);
  const missing = clientMissing(service);
  const busy = attempt.busy || clientBusy;
  const err = touched ? validateConnectName(name, required) : null;

  const requestClient = () => {
    if (busy) {
      return;
    }

    setClientBusy(true);
    setClientRefusal(null);
    api.connections.requestOauthClient(service.name).then(
      ({ requestId }) => {
        onClose();
        dispatch(routeTo({ key: 'secrets', id: requestId }));
      },
      error => {
        setClientBusy(false);
        setClientRefusal(toApiFailure(error).message);
      },
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);

    if (busy || validateConnectName(name, required)) {
      return;
    }

    attempt.begin();
    dispatch(connectService(service.name, name.trim() || null));
  };

  if (missing) {
    return (
      <Dialog title={`Connect ${service.name}`} confirm="Provide OAuth client" confirmIcon="key-round" busy={busy} onConfirm={requestClient} onClose={onClose}>
        <div className="form">
          {clientRefusal ? (
            <Note state="err" icon="circle-alert" role="alert">
              {clientRefusal}
            </Note>
          ) : null}
          <Note state="act" icon="key-round">
            Not set up: Balabash’s own OAuth client for {service.name} is missing. Provide it first; the sign-in link comes after.
          </Note>
          {service.description ? <p className="conn-connect-note">{service.description}</p> : null}
          <p className="conn-connect-note">
            The client ID and secret of the OAuth app registered at the provider are entered in a form of their own and go straight to storage — never into a chat or the log; one client serves every workspace.
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={`Connect ${service.name}`} confirm="Get sign-in link" confirmIcon="log-in" form={FORM_ID} busy={busy} onClose={onClose}>
      <form id={FORM_ID} className="form" onSubmit={submit} noValidate>
        {attempt.refusal || clientRefusal ? (
          <Note state="err" icon="circle-alert" role="alert">
            {attempt.refusal?.message ?? clientRefusal}
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
        <p className="conn-connect-note">You will sign in at {service.name} in a new tab; the account shows up here as connected when you finish.</p>
        {service.manualClient ? (
          <div>
            <Btn label="Replace OAuth client" icon="key-round" size="sm" disabled={busy} onClick={requestClient} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
