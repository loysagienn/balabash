'use client';

// The trusted window (§2 ставка 4): the secret form behind the session.
// The GET brings field metadata only; submitted values go straight to the
// core's storage and never come back — not in responses, not in events.

import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '../../../lib/api';
import { useAuthRedirect } from '../../../lib/auth-gate';
import type {
  ProvisionSecretsRequest,
  ProvisionSecretsResponse,
  SecretRequestResponse,
} from '../../../../api/contract.ts';
import styles from './secrets.module.css';

const KIND_TITLES = {
  'external-secrets': 'Секреты сервера',
  'oauth-client': 'OAuth-клиент',
} as const;

export default function SecretRequestPage() {
  const params = useParams<{ id: string }>();
  const requestId = params.id;
  const [values, setValues] = useState<Record<string, string>>({});

  const request = useQuery({
    queryKey: ['secret-request', requestId],
    queryFn: () => apiFetch<SecretRequestResponse>(`/api/secret-requests/${requestId}`),
    // The request row dies on fulfilment — never refetch a form under the
    // operator's hands.
    staleTime: Infinity,
    retry: false,
  });

  const provision = useMutation({
    mutationFn: (body: ProvisionSecretsRequest) =>
      apiFetch<ProvisionSecretsResponse>(`/api/secret-requests/${requestId}`, { method: 'POST', body }),
  });

  const unauthorized = useAuthRedirect(request.error, provision.error);

  const notFound = request.error instanceof ApiError && request.error.status === 404;

  if (unauthorized || request.isPending) {
    return (
      <main className={styles.main}>
        <p className={styles.dim}>Загрузка…</p>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className={styles.main}>
        <div className={styles.card}>
          <h1 className={styles.title}>Запрос не найден</h1>
          <p className={styles.hint}>
            Такого запроса нет — возможно, секреты уже сохранены. Если нет, попроси новую ссылку в чате.
          </p>
        </div>
      </main>
    );
  }

  if (request.error) {
    return (
      <main className={styles.main}>
        <p className={styles.error}>Не удалось загрузить запрос: {request.error.message}</p>
      </main>
    );
  }

  const info = request.data.request;

  if (provision.isSuccess) {
    return (
      <main className={styles.main}>
        <div className={styles.card}>
          <h1 className={styles.title}>Готово</h1>
          <p className={styles.hint}>
            Значения для <b>{info.server}</b> сохранены — напрямую в хранилище, мимо ассистента и журнала.
            Вкладку можно закрыть и вернуться в чат.
          </p>
        </div>
      </main>
    );
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();

    if (!provision.isPending) {
      provision.mutate({ values });
    }
  }

  return (
    <main className={styles.main}>
      <form className={styles.card} onSubmit={onSubmit}>
        <h1 className={styles.title}>
          {KIND_TITLES[info.kind]}: <span className={styles.server}>{info.server}</span>
        </h1>
        <p className={styles.hint}>
          Значения уходят напрямую в хранилище инсталляции — их не увидят ни ассистент, ни журнал событий.
        </p>

        {info.fields.map(field => (
          <label key={field.key} className={styles.field}>
            <span className={styles.label}>
              {field.label}
              {field.required ? '' : ' (необязательно)'}
            </span>
            <span className={styles.description}>{field.description}</span>
            <input
              className={styles.input}
              type={field.secret ? 'password' : 'text'}
              value={values[field.key] ?? ''}
              onChange={event => setValues(prev => ({ ...prev, [field.key]: event.target.value }))}
              required={field.required}
              autoComplete={field.secret ? 'new-password' : 'off'}
              spellCheck={false}
            />
          </label>
        ))}

        <button className={styles.submit} type="submit" disabled={provision.isPending}>
          {provision.isPending ? 'Сохраняю…' : 'Сохранить'}
        </button>
        {provision.error && !unauthorized ? <p className={styles.error}>{provision.error.message}</p> : null}
      </form>
    </main>
  );
}
