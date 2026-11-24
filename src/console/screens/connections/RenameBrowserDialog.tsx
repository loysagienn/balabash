// "Browser name": the name the user and the agents tell a browser by, over
// PATCH /api/browsers/:id. The dialog's own check (not empty) and the
// server's refusal (a name another browser of the user has) show under the
// field; an unchanged name just closes.

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BrowserView } from '../../../api/contract.ts';
import { toApiFailure } from '../../lib/api/index.ts';
import { useApi } from '../../lib/api/context.tsx';
import { BROWSERS_KEY } from '../../lib/query/browsers.ts';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { BROWSER_NAME_MAX_LENGTH, validateBrowserName } from './Browsers.logic.ts';

const FORM_ID = 'rename-browser';

export function RenameBrowserDialog({ browser, onClose }: { browser: BrowserView; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [name, setName] = useState(browser.name);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const err = (touched ? validateBrowserName(name) : null) ?? refusal;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);

    if (busy || validateBrowserName(name)) {
      return;
    }

    if (name.trim() === browser.name) {
      onClose();

      return;
    }

    setBusy(true);
    api.browsers.rename(browser.id, name.trim()).then(
      () => {
        void queryClient.invalidateQueries({ queryKey: BROWSERS_KEY });
        onClose();
      },
      error => {
        setBusy(false);
        setRefusal(toApiFailure(error).message);
      },
    );
  };

  return (
    <Dialog title="Browser name" confirm="Save" form={FORM_ID} busy={busy} onClose={onClose}>
      <form id={FORM_ID} className="form" onSubmit={submit} noValidate>
        <Field label="Name" fid={`${FORM_ID}-name`} hint="How you and the agents tell your browsers apart." err={err} required>
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
      </form>
    </Dialog>
  );
}
