// A service of the installation (the catalog's tile): an external server on
// the installation's credentials — one set for every workspace. The dialog
// says its state (connected, not set up — which credentials are missing,
// connection failed — why) and offers "Provide secrets" / "Replace
// secrets": the server opens a request for the credentials (addressed to
// the main thread, as the auth agent's would be) and the tab goes to its
// secrets form (/secrets/<id>), where the values go straight to storage.
// With credentials in place, "Forget secrets" asks for a confirmation
// (rule 13) and deletes them: the server disconnects for every workspace.
// A refusal of the server stays in the dialog; the outcome of forgetting
// is a toast, and the list is read again.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { InstallationServiceView } from '../../../api/contract.ts';
import { useApi } from '../../lib/api/context.tsx';
import { toApiFailure } from '../../lib/api/index.ts';
import { useAppDispatch } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { pushToast } from '../../store/ui/actions.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Confirm } from '../../ui/Confirm/Confirm.tsx';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Code } from '../../ui/atoms/atoms.tsx';
import { INSTALLATION_SERVICES_KEY } from './queries.ts';

export function InstallationServiceDialog({ service, onClose }: { service: InstallationServiceView; onClose: () => void }) {
  const api = useApi();
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const missing = service.state === 'missing';

  const provide = () => {
    if (busy) {
      return;
    }

    setBusy(true);
    setRefusal(null);
    api.installationServices.requestSecrets(service.name).then(
      ({ requestId }) => {
        onClose();
        dispatch(routeTo({ key: 'secrets', id: requestId }));
      },
      error => {
        setBusy(false);
        setRefusal(toApiFailure(error).message);
      },
    );
  };

  const forget = () => {
    if (busy) {
      return;
    }

    setBusy(true);
    api.installationServices.forgetSecrets(service.name).then(
      () => {
        void queryClient.invalidateQueries({ queryKey: INSTALLATION_SERVICES_KEY });
        dispatch(pushToast({ title: `${service.name}: credentials forgotten`, desc: 'Its tools are gone for every workspace until the credentials are provided again.', state: 'done' }));
        onClose();
      },
      error => {
        void queryClient.invalidateQueries({ queryKey: INSTALLATION_SERVICES_KEY });
        dispatch(pushToast({ title: `Couldn’t forget the ${service.name} credentials`, desc: toApiFailure(error).message, state: 'err' }));
        onClose();
      },
    );
  };

  if (forgetting) {
    return (
      <Confirm title={`Forget the ${service.name} credentials?`} confirm="Forget" confirmIcon="unplug" cancel="Keep" busy={busy} onConfirm={forget} onClose={onClose}>
        {`The values are deleted from Balabash and ${service.name} disconnects: agents of every workspace lose its tools. You can provide the credentials again from the catalog.`}
      </Confirm>
    );
  }

  return (
    <Dialog title={service.name} confirm={missing ? 'Provide secrets' : 'Replace secrets'} confirmIcon="key-round" busy={busy} onConfirm={provide} onClose={onClose}>
      <div className="form">
        {refusal ? (
          <Note state="err" icon="circle-alert" role="alert">
            {refusal}
          </Note>
        ) : null}
        {service.state === 'connected' ? (
          <Note icon="circle-check">Connected. One set of credentials serves every workspace of this installation.</Note>
        ) : service.state === 'failed' ? (
          <Note state="err" icon="triangle-alert">
            Couldn’t connect with the credentials in place: {service.error}
          </Note>
        ) : (
          <Note state="act" icon="key-round">
            Not set up: the credentials are missing.
          </Note>
        )}
        {service.description ? <p className="conn-connect-note">{service.description}</p> : null}
        <p className="conn-connect-note">
          Credentials:{' '}
          {service.secretNames.map((name, i) => (
            <span key={name}>
              {i > 0 ? ', ' : null}
              <Code>{name}</Code>
            </span>
          ))}
          . They are entered in a form of their own and go straight to storage — never into a chat or the log; the change applies to every workspace.
        </p>
        {missing ? null : (
          <div>
            <Btn label="Forget secrets" icon="unplug" variant="danger" size="sm" disabled={busy} onClick={() => setForgetting(true)} />
          </div>
        )}
      </div>
    </Dialog>
  );
}
