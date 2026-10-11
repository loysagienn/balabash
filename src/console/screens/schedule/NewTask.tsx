// "New task" (design: ScheduleScreen modal / create): the form that
// registers a task over CREATE_TASK — a Modal over the list when the shell
// is wide, a screen of its own on the phone (the route's `new`; the shell
// draws "Back" and the title there). The same fields in both: the name and
// the slug it derives (a code task's body is named by it), the kind, an
// optional description, the trigger — on a schedule with the expression
// spelled out and its next run in the schedule's time zone, once at a
// moment typed as that zone's clock, or manual only — and the fields of
// the kind: the note of a reminder, the command, folder, timeout and
// "notify on success" of a command job. The zone is a fact of the server:
// until it has come (or when its read failed — Retry), a schedule and a
// moment are not read and not sent; "Manual only" is. The form's own
// checks show under the fields after the first submit, then stay current
// while typing; a refusal of the server goes under the field it names, or
// above the form when it names none (taskForm.logic.ts). The draft and the
// attempt live in the host, above the modal-or-screen switch: crossing the
// shell's width (a turned phone, a resized window) moves the form, it does
// not empty it. The store routes to the created task when the answer comes
// while the form is still open (store/schedule/handlers.ts), so the form
// itself has nothing to do when its attempt is accepted. Closing goes back
// to the list, the search kept.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ScheduleRoute } from '../../lib/router/routes.ts';
import { useFormAttempt } from '../../lib/forms/useAttempt.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { createTask } from '../../store/schedule/actions.ts';
import { selectTaskCreate } from '../../store/schedule/selectors.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Card, CardBody } from '../../ui/Card/Card.tsx';
import { Check } from '../../ui/Check/Check.tsx';
import { useNarrowShell } from '../../ui/Dialog/Dialog.tsx';
import { Field, focusFirstInvalid } from '../../ui/Field/Field.tsx';
import { Icon } from '../../ui/Icon/Icon.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Modal } from '../../ui/Modal/Modal.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Seg, SegItem } from '../../ui/Seg/Seg.tsx';
import { withScheduleFilters } from './ScheduleScreen.logic.ts';
import {
  DESCRIPTION_MAX_LENGTH,
  KIND_LABELS,
  NAME_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  WHEN_LABELS,
  atHint,
  changeTaskForm,
  codeHint,
  cronFieldHint,
  fieldOfTaskFailure,
  initialTaskForm,
  instantInZone,
  taskRequest,
  validateTaskForm,
  zoneNoteWords,
} from './taskForm.logic.ts';
import type { TaskFormErrors, TaskFormField, TaskFormValues, TaskKind, TaskWhen } from './taskForm.logic.ts';

const FORM_ID = 'new-task';
const KINDS: TaskKind[] = ['note', 'code', 'command'];
const WHENS: TaskWhen[] = ['cron', 'at', 'manual'];

// The schedule's time zone as the form gets it: the zone, or not yet —
// with the failure of its read, if it failed, and the way to read again.
export type FormZone = { timezone: string | null; failure: string | null; busy: boolean; retry: () => void };

type Draft = {
  values: TaskFormValues;
  errors: TaskFormErrors;
  failure: string | null;
  // Submits so far: the form puts the focus on the first error of each.
  attempts: number;
  change: (field: TaskFormField | 'reportOnSuccess', value: string | boolean) => void;
  submit: (event: FormEvent) => void;
};

// The host: the probe tells which window the shell is; `children` is the
// list the modal sits over when wide. The draft is held here, whichever
// of the two shows it.
export function NewTask({ route, zone, now, children }: { route: ScheduleRoute; zone: FormZone; now: Date; children: ReactNode }) {
  const dispatch = useAppDispatch();
  const probe = useRef<HTMLSpanElement>(null);
  const narrow = useNarrowShell(probe);
  const form = useAppSelector(selectTaskCreate);
  const close = useCallback(() => dispatch(routeTo(withScheduleFilters(route, { new: undefined }), { replace: true })), [dispatch, route]);
  const draft = useDraft(zone.timezone, now);
  const busy = form.pending;

  return (
    <>
      <span ref={probe} className="dialog-probe" hidden />
      {narrow === null ? null : narrow ? (
        <>
          <Card narrow="bare" label="New task">
            <CardBody>
              <NewTaskForm draft={draft} zone={zone} now={now} />
            </CardBody>
          </Card>
          <Btn label="Create task" icon="plus" variant="primary" block type="submit" form={FORM_ID} busy={busy} />
        </>
      ) : (
        <>
          {children}
          <Modal title="New task" confirm="Create task" confirmIcon="plus" width="560px" form={FORM_ID} busy={busy} onClose={close}>
            <NewTaskForm draft={draft} zone={zone} now={now} />
          </Modal>
        </>
      )}
    </>
  );
}

function useDraft(timezone: string | null, now: Date): Draft {
  const dispatch = useAppDispatch();
  const form = useAppSelector(selectTaskCreate);
  // The store owns what happens when the call is accepted (the created
  // task opens in the form's place).
  const accepted = useCallback(() => undefined, []);
  const attempt = useFormAttempt(form, accepted);
  const [values, setValues] = useState(initialTaskForm);
  const [touched, setTouched] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const errors: TaskFormErrors = touched ? validateTaskForm(values, now, timezone) : {};
  let failure: string | null = null;

  if (attempt.refusal) {
    const field = fieldOfTaskFailure(attempt.refusal.message);

    if (field && !errors[field]) {
      errors[field] = attempt.refusal.message;
    } else if (!field) {
      failure = attempt.refusal.message;
    }
  }

  return {
    values,
    errors,
    failure,
    attempts,
    change: (field, value) => {
      setValues(current => changeTaskForm(current, field, value));
      attempt.input();
    },
    submit: event => {
      event.preventDefault();
      setTouched(true);
      setAttempts(n => n + 1);

      if (attempt.busy || Object.keys(validateTaskForm(values, now, timezone)).length > 0) {
        return;
      }

      attempt.begin();
      dispatch(createTask(taskRequest(values, timezone)));
    },
  };
}

function NewTaskForm({ draft, zone, now }: { draft: Draft; zone: FormZone; now: Date }) {
  const { values, errors, failure, attempts, change, submit } = draft;
  const element = useRef<HTMLFormElement>(null);
  const timezone = zone.timezone;
  // After a submit the errors of that attempt are on the screen: the focus
  // goes to the first of them (none — the call went out, the focus stays).
  // The submits made before this form was mounted (the other shell) are
  // not refocused.
  const focused = useRef(attempts);

  useEffect(() => {
    if (attempts !== focused.current) {
      focused.current = attempts;
      focusFirstInvalid(element.current);
    }
  }, [attempts]);

  const fid = (field: string) => `${FORM_ID}-${field}`;
  const at = values.when === 'at' && timezone ? instantInZone(values.at, timezone) : null;
  const command = values.kind === 'command';

  return (
    <form id={FORM_ID} className="form" ref={element} onSubmit={submit} noValidate>
      {failure ? (
        <Note state="err" icon="circle-alert" role="alert">
          {failure}
        </Note>
      ) : null}
      <Field label="Name" fid={fid('name')} err={errors.name} required>
        <Input id={fid('name')} name="name" value={values.name} onChange={value => change('name', value)} maxLength={NAME_MAX_LENGTH} autoComplete="off" autoFocus invalid={Boolean(errors.name)} />
      </Field>
      <Field label="Slug" fid={fid('slug')} hint="The task’s id, how agents and the log name it; a code task’s body file is named by it. Can’t be changed later." err={errors.slug} required>
        <Input id={fid('slug')} name="slug" value={values.slug} onChange={value => change('slug', value)} mono maxLength={SLUG_MAX_LENGTH} autoComplete="off" autoCapitalize="off" spellCheck={false} invalid={Boolean(errors.slug)} />
      </Field>
      <Field label="Kind" fid={fid('kind')} hint={values.kind === 'code' ? codeHint(values.slug) : values.kind === 'note' ? 'At its moment the note lands in the main thread and the secretary acts on it.' : 'A shell command run in the file area (bash -c); every run is journaled.'}>
        <Seg label="Kind">
          {KINDS.map(kind => (
            <SegItem key={kind} label={KIND_LABELS[kind]} sel={values.kind === kind} onClick={() => change('kind', kind)} />
          ))}
        </Seg>
      </Field>
      {values.kind === 'note' ? (
        <Field label="Note" fid={fid('note')} err={errors.note} required>
          <Input as="textarea" id={fid('note')} name="note" value={values.note} onChange={value => change('note', value)} rows={2} placeholder="What the secretary should do when it fires" invalid={Boolean(errors.note)} />
        </Field>
      ) : null}
      <Field label="Description" fid={fid('description')} opt="optional" err={errors.description}>
        <Input as="textarea" id={fid('description')} name="description" value={values.description} onChange={value => change('description', value)} rows={2} maxLength={DESCRIPTION_MAX_LENGTH} invalid={Boolean(errors.description)} />
      </Field>
      <Field label="When" fid={fid('when')} hint={values.when === 'manual' ? 'No trigger: the task runs on “Run now” or when an agent starts it.' : undefined}>
        <Seg label="When">
          {WHENS.map(when => (
            <SegItem key={when} label={WHEN_LABELS[when]} sel={values.when === when} onClick={() => change('when', when)} />
          ))}
        </Seg>
      </Field>
      {values.when !== 'manual' && !timezone ? (
        zone.failure ? (
          <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" actionBusy={zone.busy} onAction={zone.retry}>
            {zoneNoteWords(zone.failure)}
          </Note>
        ) : (
          <Note state="wait" icon="hourglass" role="status">
            {zoneNoteWords(null)}
          </Note>
        )
      ) : null}
      {values.when === 'cron' ? (
        <Field label="Schedule" fid={fid('cron')} hint={cronFieldHint(values.cron, now, timezone)} err={errors.cron} required>
          <Input id={fid('cron')} name="cron" value={values.cron} onChange={value => change('cron', value)} mono placeholder="0 4 * * *" autoComplete="off" spellCheck={false} end={<Icon name="calendar-clock" />} invalid={Boolean(errors.cron)} />
        </Field>
      ) : null}
      {values.when === 'at' ? (
        <Field label="Moment" fid={fid('at')} hint={atHint(at, now, timezone)} err={errors.at} required>
          <Input id={fid('at')} name="at" type="datetime-local" value={values.at} onChange={value => change('at', value)} mono invalid={Boolean(errors.at)} />
        </Field>
      ) : null}
      {command ? (
        <>
          <Field label="Command" fid={fid('command')} err={errors.command} required>
            <Input as="textarea" id={fid('command')} name="command" value={values.command} onChange={value => change('command', value)} rows={2} mono spellCheck={false} placeholder="./venv/bin/python collect.py" invalid={Boolean(errors.command)} />
          </Field>
          <Field label="Workspace folder" fid={fid('cwd')} opt="optional" hint="Where the command runs, relative to the file area; empty — its root." err={errors.cwd}>
            <Input id={fid('cwd')} name="cwd" value={values.cwd} onChange={value => change('cwd', value)} pre="~/" mono autoComplete="off" autoCapitalize="off" spellCheck={false} invalid={Boolean(errors.cwd)} />
          </Field>
          <Field label="Timeout" fid={fid('timeout')} opt="optional" hint="1s to 5h; 10m when empty. The process group is killed on expiry." err={errors.timeout}>
            <Input id={fid('timeout')} name="timeout" value={values.timeout} onChange={value => change('timeout', value)} placeholder="10m" autoComplete="off" invalid={Boolean(errors.timeout)} />
          </Field>
          <Check kind="switch" label="Notify on successful runs" checked={values.reportOnSuccess} onChange={checked => change('reportOnSuccess', checked)} />
        </>
      ) : null}
    </form>
  );
}
