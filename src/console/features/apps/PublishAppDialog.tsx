// "Publish" (design: AppsScreen modal / sheet): the public URL of an app
// over PUBLISH_APP. The slug is suggested from the app's name; a slug
// another app of the workspace holds is told at once, with the confirm
// disabled (the server would refuse it too, without saying whose it is);
// the server's rule shows under the field after the first submit; a refusal
// of the server about the slug — under the field, about anything else (a
// broken manifest, the folder) — above the form. The dialog lives by an
// attempt (lib/forms/attempt.ts): it closes when the store counted its own
// call as accepted, the values stay live during the call.

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AppListingView } from '../../../api/contract.ts';
import { attemptAccepted, attemptAfterInput, attemptRefusal } from '../../lib/forms/attempt.ts';
import type { FormAttempt } from '../../lib/forms/attempt.ts';
import { appTitle, appUrlText, publicAppAddress } from '../../lib/apps/appLink.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { publishApp } from '../../store/apps/actions.ts';
import { selectAppPublish } from '../../store/apps/selectors.ts';
import { Dialog } from '../../ui/Dialog/Dialog.tsx';
import { Field, focusFirstInvalid } from '../../ui/Field/Field.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { APP_SLUG_MAX_LENGTH, normalizeSlug, publishFailureUnderField, slugError, slugTakenBy, suggestedSlug, takenWords } from './publishApp.logic.ts';

const FORM_ID = 'publish-app';
const FIELD_ID = `${FORM_ID}-slug`;

export function PublishAppDialog({ app, onClose }: { app: AppListingView; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const form = useAppSelector(s => selectAppPublish(s, app.path));
  const apps = useAppSelector(s => s.apps.items);
  const base = useAppSelector(s => s.apps.publicAppsBase);
  const formEl = useRef<HTMLFormElement>(null);
  const [value, setValue] = useState(() => suggestedSlug(app));
  const [touched, setTouched] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [attempt, setAttempt] = useState<FormAttempt | null>(null);

  // The store counted the call of this attempt as accepted: the dialog's
  // work is done.
  useEffect(() => {
    if (attemptAccepted(attempt, form)) {
      onClose();
    }
  }, [form, attempt, onClose]);

  // After a submit the errors of that attempt are on the screen: the focus
  // goes to the field at fault (none — the call went out, the focus stays).
  useEffect(() => {
    if (attempts > 0) {
      focusFirstInvalid(formEl.current);
    }
  }, [attempts]);

  const slug = normalizeSlug(value);
  const own = slugError(slug);
  const taken = slugTakenBy(apps, slug, app.path);
  const refusal = attemptRefusal(attempt, form);
  let err: string | null = touched ? own : null;
  let failure: string | null = null;

  if (!err && taken) {
    err = takenWords(taken);
  }

  if (!err && refusal) {
    if (publishFailureUnderField(refusal.message)) {
      err = refusal.message;
    } else {
      failure = refusal.message;
    }
  }

  const address = own === null ? appUrlText(publicAppAddress(base, slug)) : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    setAttempts(n => n + 1);

    if (form.pending || own !== null || taken) {
      return;
    }

    setAttempt({ done: form.done });
    dispatch(publishApp(app.path, slug));
  };

  return (
    <Dialog title={`Publish “${appTitle(app)}”`} confirm="Publish" confirmIcon="globe" confirmDisabled={taken !== null} form={FORM_ID} busy={form.pending} onClose={onClose}>
      <form id={FORM_ID} className="form" ref={formEl} onSubmit={submit} noValidate>
        {failure ? (
          <Note state="err" icon="circle-alert" role="alert">
            {failure}
          </Note>
        ) : null}
        <Field label="Public URL" fid={FIELD_ID} hint={address ? 'Anyone with the link can open the app without signing in: ' : 'Anyone with the link can open the app without signing in.'} hintCode={address ?? undefined} err={err} required>
          <Input
            id={FIELD_ID}
            name="slug"
            value={value}
            onChange={next => {
              setValue(next);
              // A new value after a refusal dismisses it; during the call
              // the attempt stands — its answer is still to come.
              setAttempt(current => attemptAfterInput(current, form));
            }}
            pre={`${appUrlText(base)}/`}
            mono
            maxLength={APP_SLUG_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            invalid={Boolean(err)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
