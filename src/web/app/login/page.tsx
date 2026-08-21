'use client';

// Login: exchange a one-time code from the telegram bot (/auth_code) for a
// long-lived session cookie. No passwords by design.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { apiFetch } from '../../lib/api';
import { sanitizeNextPath } from '../../lib/auth-gate';
import type { AuthRequest, MeResponse } from '../../../api/contract';
import styles from './login.module.css';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');

  const auth = useMutation({
    mutationFn: (body: AuthRequest) => apiFetch<MeResponse>('/api/auth', { method: 'POST', body }),
    onSuccess: me => {
      queryClient.setQueryData(['me'], me);

      const next = sanitizeNextPath(searchParams.get('next'));

      // /apps/* lives outside the Next app (Koa handoff to the apps domain).
      // A client-side router.replace would RSC-fetch it, hit the cross-origin
      // 302 to balabash.app/auth, fail on CORS and burn a one-time handoff
      // token before falling back to a full navigation — so go hard right away.
      if (next === '/apps' || next.startsWith('/apps/')) {
        window.location.assign(next);
      } else {
        router.replace(next);
      }
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();

    const trimmed = code.trim();

    if (trimmed && !auth.isPending) {
      auth.mutate({ code: trimmed });
    }
  }

  return (
    <main className={styles.main}>
      <form className={styles.card} onSubmit={onSubmit}>
        <h1 className={styles.title}>Balabash</h1>
        <p className={styles.hint}>
          Отправь боту команду <code>/auth_code</code> в группе воркспейса и введи полученный код.
        </p>
        <input
          className={styles.input}
          value={code}
          onChange={event => setCode(event.target.value.toUpperCase())}
          placeholder="Код из Telegram"
          autoComplete="one-time-code"
          autoFocus
          spellCheck={false}
        />
        <button className={styles.submit} type="submit" disabled={auth.isPending || !code.trim()}>
          {auth.isPending ? 'Проверяю…' : 'Войти'}
        </button>
        {auth.error ? <p className={styles.error}>{auth.error.message}</p> : null}
      </form>
    </main>
  );
}

// useSearchParams needs a Suspense boundary for the static prerender.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
