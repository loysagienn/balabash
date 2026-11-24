// "Rename browser": the name the user, the members of its workspaces and
// the agents tell a browser by, over PATCH /api/browsers/:id. The dialog's
// own check (not empty, not too long) and the server's refusal (a name
// another browser of the user has) show under the field; an unchanged name
// just closes.

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BrowserView } from '../../../api/contract.ts';
import { toApiFailure } from '../../lib/api/index.ts';
import { useApi } from '../../lib/api/context.tsx';
import { BROWSERS_KEY } from '../../lib/query/browsers.ts';
import { failureWords } from '../../store/browsers/words.ts';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { BROWSER_NAME_MAX_LENGTH, nameError, nameRefusal } from './Browsers.logic.ts';

const FORM_ID = 'rename-browser';

export function RenameBrowserDialog({ browser, onClose }: { browser: BrowserView; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [name, setName] = useState(browser.name);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (busy) {
      return;
    }

    const wrong = nameError(name);

    setRefusal(wrong);

    if (wrong) {
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
        const failure = toApiFailure(error);

        setBusy(false);
        setRefusal(nameRefusal(name, failure) ?? failureWords(failure));
      },
    );
  };

  return (
    <Dialog title="Rename browser" confirm="Save" form={FORM_ID} busy={busy} onClose={onClose}>
      <form id={FORM_ID} className="form" onSubmit={submit} noValidate>
        <Field label="Name" fid={`${FORM_ID}-name`} hint="Up to 60 characters. You and the members of its workspaces see it; agents pick a browser by it." err={refusal} required>
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
            invalid={Boolean(refusal)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
