// "Connect this browser": the pairing of the browser the console is open
// in. The user names the browser; the server issues a one-time code for
// that name (POST /api/browsers/pairings), the page hands the code to the
// extension (lib/extension), and the extension dials the server with it —
// from then on the browser is the user's, enabled in this workspace. A
// refusal of the name shows under the field; a pairing that did not happen
// — as a note, and the dialog stays for another try.

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toApiFailure } from '../../lib/api/index.ts';
import { useApi } from '../../lib/api/context.tsx';
import { pairExtension } from '../../lib/extension/index.ts';
import { BROWSERS_KEY } from '../../lib/query/browsers.ts';
import { useAppDispatch } from '../../store/hooks.ts';
import { pushToast } from '../../store/ui/actions.ts';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { BROWSER_NAME_MAX_LENGTH, defaultBrowserName, pairErrorWords, validateBrowserName } from './Browsers.logic.ts';

const FORM_ID = 'connect-browser';

export function ConnectBrowserDialog({ extensionId, onClose }: { extensionId: string; onClose: () => void }) {
  const api = useApi();
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const [name, setName] = useState(() => defaultBrowserName(navigator.userAgent));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  // The server's refusal of the name, and why a pairing did not happen.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const err = (touched ? validateBrowserName(name) : null) ?? refusal;

  const connect = async () => {
    const clean = name.trim();
    let code: string;

    try {
      ({ code } = await api.browsers.requestPairing(clean));
    } catch (error) {
      const refused = toApiFailure(error);

      if (refused.status === 400 || refused.status === 409) {
        setRefusal(refused.message);
      } else {
        setFailure(refused.message);
      }

      return;
    }

    const result = await pairExtension(extensionId, code);

    if (!result.ok) {
      setFailure(pairErrorWords(result.error));

      return;
    }

    void queryClient.invalidateQueries({ queryKey: BROWSERS_KEY });
    dispatch(pushToast({ title: `“${clean}” is connected`, desc: 'Agents of this workspace can use this browser.', state: 'done' }));
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);

    if (busy || validateBrowserName(name)) {
      return;
    }

    setBusy(true);
    setFailure(null);
    void connect().finally(() => setBusy(false));
  };

  return (
    <Dialog title="Connect this browser" confirm="Connect" confirmIcon="plug" form={FORM_ID} busy={busy} onClose={onClose}>
      <form id={FORM_ID} className="form" onSubmit={submit} noValidate>
        <Field label="Name" fid={`${FORM_ID}-name`} hint="How you and the agents tell your browsers apart. You can change it later." err={err} required>
          <Input
            id={`${FORM_ID}-name`}
            name="name"
            value={name}
            onChange={value => {
              setName(value);
              setRefusal(null);
            }}
            maxLength={BROWSER_NAME_MAX_LENGTH}
            autoComplete="off"
            autoFocus
            invalid={Boolean(err)}
          />
        </Field>
        {failure ? (
          <Note state="err" icon="circle-alert" role="alert">
            {failure}
          </Note>
        ) : null}
        <p className="conn-connect-note">The browser is enabled in this workspace: its agents can open pages in it and act in them under your logins. Chrome shows a bar while an agent works.</p>
      </form>
    </Dialog>
  );
}
