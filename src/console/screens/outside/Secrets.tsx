// Secret entry (design: Solo, the brief's "trusted window"): the form of a
// one-time link an agent hands out — /secrets/<id>. Behind the session
// like everything else (App draws the sign-in card over the route and this
// form after it); the API gives field metadata only, the values go
// straight to storage and never come back. The request is the second data
// layer (TanStack Query over the Api): fetched once and never refetched —
// the row dies on fulfilment, and a form under the operator's hands must
// not turn into "Link expired" on its own. Cards: loading · the form ·
// saved · link expired (404 — used or never issued) · couldn't load
// (anything else, with Retry). A refusal of the server after submit stays
// above the form with the values kept for another try.

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { SecretRequestView } from '../../../api/contract.ts';
import { useApi } from '../../lib/api/context.tsx';
import { toApiFailure } from '../../lib/api/index.ts';
import { retryUnlessClient } from '../../lib/api/retry.ts';
import { Btn } from '../../ui/Btn/Btn.tsx';
import { Field, focusFirstInvalid } from '../../ui/Field/Field.tsx';
import { Input } from '../../ui/Input/Input.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { SkelStack } from '../../ui/Skel/Skel.tsx';
import { Solo, SoloText } from '../../ui/Solo/Solo.tsx';
import { Code } from '../../ui/atoms/atoms.tsx';
import { missingRequired, provisionValues, secretsFailure, secretsTitle, submitLabel } from './Secrets.logic.ts';
import type { SecretErrors, SecretValues } from './Secrets.logic.ts';

const BRAND = 'Balabash · one-time link';

export function Secrets({ id }: { id: string }) {
  const api = useApi();
  const request = useQuery({
    queryKey: ['secret-request', id],
    queryFn: ({ signal }) => api.secretRequests.get(id, signal),
    retry: retryUnlessClient,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const provision = useMutation({
    mutationFn: (values: SecretValues) => api.secretRequests.provision(id, values),
  });

  if (provision.isSuccess) {
    return <Saved request={request.data?.request ?? null} />;
  }

  // A refusal after submit: the row is gone — the link is spent, whatever
  // the form still shows.
  const refusal = provision.error ? secretsFailure(toApiFailure(provision.error)) : null;

  if (refusal?.kind === 'expired') {
    return <Expired />;
  }

  if (request.isPending) {
    return (
      <Solo brand={BRAND} title="Secrets">
        <div aria-busy="true">
          <SkelStack widths={[90, 70, 55]} />
        </div>
      </Solo>
    );
  }

  if (request.isError) {
    const failure = secretsFailure(toApiFailure(request.error));

    if (failure.kind === 'expired') {
      return <Expired />;
    }
    if (failure.kind === 'session') {
      return null;
    }

    return (
      <Solo brand={BRAND} icon="circle-x" iconState="err" title="Couldn’t load the request">
        <SoloText>{failure.message}</SoloText>
        <Btn label="Try again" icon="refresh-cw" block busy={request.isFetching} onClick={() => void request.refetch()} />
      </Solo>
    );
  }

  return (
    <SecretsForm
      request={request.data.request}
      busy={provision.isPending}
      failure={refusal?.kind === 'failed' ? refusal.message : null}
      onSubmit={values => provision.mutate(values)}
    />
  );
}

type SecretsFormProps = {
  request: SecretRequestView;
  busy: boolean;
  // A refusal of the server that belongs to the whole form.
  failure: string | null;
  onSubmit: (values: SecretValues) => void;
};

function SecretsForm({ request, busy, failure, onSubmit }: SecretsFormProps) {
  const form = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<SecretValues>({});
  const [errors, setErrors] = useState<SecretErrors>({});
  const [attempts, setAttempts] = useState(0);

  // After a submit that failed the form's own check the errors are on the
  // screen: the focus goes to the first of them.
  useEffect(() => {
    if (attempts > 0) {
      focusFirstInvalid(form.current);
    }
  }, [attempts]);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (busy) {
      return;
    }

    const missing = missingRequired(request.fields, values);

    setErrors(missing);
    setAttempts(n => n + 1);

    if (Object.keys(missing).length === 0) {
      onSubmit(provisionValues(request.fields, values));
    }
  };
  const change = (key: string, value: string) => {
    setValues(prev => ({ ...prev, [key]: value }));
    setErrors(prev => (prev[key] ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)) : prev));
  };

  return (
    <Solo brand={BRAND} icon="key-round" title={secretsTitle(request)}>
      <SoloText>The values go straight to the installation’s storage — neither the agent nor the event log sees them.</SoloText>
      <form className="form" ref={form} onSubmit={submit} noValidate>
        {failure ? (
          <Note state="err" icon="circle-alert" role="alert">
            {failure}
          </Note>
        ) : null}
        {request.fields.map((field, index) => {
          const fid = `secret-${field.key}`;

          return (
            <Field key={field.key} label={field.label} fid={fid} opt={field.required ? undefined : 'optional'} hint={field.description} err={errors[field.key]} required={field.required}>
              <Input
                id={fid}
                name={field.key}
                type={field.secret ? 'password' : 'text'}
                value={values[field.key] ?? ''}
                onChange={value => change(field.key, value)}
                mono
                autoFocus={index === 0}
                autoComplete={field.secret ? 'new-password' : 'off'}
                autoCapitalize="off"
                spellCheck={false}
                invalid={Boolean(errors[field.key])}
                disabled={busy}
              />
            </Field>
          );
        })}
        <Btn type="submit" label={submitLabel(busy)} variant="primary" block busy={busy} />
      </form>
    </Solo>
  );
}

function Saved({ request }: { request: SecretRequestView | null }) {
  return (
    <Solo brand={BRAND} icon="circle-check" iconState="done" title="Secrets saved">
      <SoloText>
        {request ? (
          <>
            The values for <Code>{request.server}</Code> are in storage.
          </>
        ) : (
          'The values are in storage.'
        )}{' '}
        You can close this tab — the agent is already carrying on.
      </SoloText>
    </Solo>
  );
}

function Expired() {
  return (
    <Solo brand={BRAND} icon="clock-alert" iconState="act" title="Link expired">
      <SoloText>This one-time link has been used or has expired. Ask the agent to send a new one.</SoloText>
    </Solo>
  );
}
