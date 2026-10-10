// "Account name" (design: the Rename sheet of the Connections screen): the
// name agents see when they pick an account, over RENAME_CONNECTION. The
// address (the slug) and the provider identity never change — the hint
// says who the account is. The dialog's own check (not empty) shows under
// the field after a submit; the server's refusal (a name another account
// of the service already has) shows the same way; the dialog closes when
// the store counted the call as accepted. An unchanged name just closes.

import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import type { ConnectionView } from '../../../api/contract.ts';
import { useFormAttempt } from '../../lib/forms/useAttempt.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { renameConnection } from '../../store/connections/actions.ts';
import { selectConnectionRename } from '../../store/connections/selectors.ts';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { Field } from '../../ui/Field/Field.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { NAME_MAX_LENGTH, validateRename } from './ConnectionsScreen.logic.ts';

const FORM_ID = 'rename-connection';

export function RenameConnectionDialog({ connection, onClose }: { connection: ConnectionView; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const form = useAppSelector(s => selectConnectionRename(s, connection.id));
  const done = useCallback(() => onClose(), [onClose]);
  const attempt = useFormAttempt(form, done);
  const [name, setName] = useState(connection.displayName);
  const [touched, setTouched] = useState(false);
  const own = touched ? validateRename(name) : null;
  const err = own ?? attempt.refusal?.message ?? null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);

    if (attempt.busy || validateRename(name)) {
      return;
    }

    if (name.trim() === connection.displayName) {
      onClose();

      return;
    }

    attempt.begin();
    dispatch(renameConnection(connection.id, name.trim()));
  };

  return (
    <Dialog title="Account name" confirm="Save" form={FORM_ID} busy={attempt.busy} onClose={onClose}>
      <form id={FORM_ID} className="form" onSubmit={submit} noValidate>
        <Field label="Name in Balabash" fid={`${FORM_ID}-name`} hint={`${connection.server} · ${connection.identity ?? connection.accountKey}. Agents see this name when they pick an account.`} err={err} required>
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
      </form>
    </Dialog>
  );
}
