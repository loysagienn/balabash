'use client';

// Login: exchange a one-time code (issued by any connected channel, e.g.
// /auth_code in Telegram) for a long-lived session cookie. No passwords by
// design. Without any channel the page itself asks the server for a code:
// the word "console" in the code field → POST /api/auth/console-code → the
// code lands in the server log, where the operator reads it (ssh).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { apiFetch } from '../../lib/api';
import { sanitizeNextPath } from '../../lib/auth-gate';
import type { AuthRequest, MeResponse } from '../../../api/contract';
import styles from './login.module.css';

// Typed into the code field instead of a code: asks the server to print a
// login code for the operator's workspace into its log.
const CONSOLE_WORD = 'console';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [consoleNotice, setConsoleNotice] = useState<string | null>(null);

  const consoleCode = useMutation({
    mutationFn: () => apiFetch<null>('/api/auth/console-code', { method: 'POST' }),
    onSuccess: () => {
      setCode('');
      setConsoleNotice('Код напечатан в лог сервера. Прочитай его там и введи здесь — действует 10 минут.');
    },
  });

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

    if (!trimmed || auth.isPending || consoleCode.isPending) {
      return;
    }

    setConsoleNotice(null);

    if (trimmed.toLowerCase() === CONSOLE_WORD) {
      consoleCode.mutate();
    } else {
      auth.mutate({ code: trimmed });
    }
  }

  return (
    <main className={styles.main}>
      <form className={styles.card} onSubmit={onSubmit}>
        <h1 className={styles.title}>Balabash</h1>
        <p className={styles.hint}>
          Введи одноразовый код для входа. Код выдаёт любой подключённый канал Balabash (в Telegram — команда{' '}
          <code>/auth_code</code>); без каналов набери здесь <code>console</code> и нажми Enter — код напечатается в лог
          сервера.
        </p>
        <input
          className={styles.input}
          value={code}
          onChange={event => setCode(event.target.value.toUpperCase())}
          placeholder="Одноразовый код"
          autoComplete="one-time-code"
          autoFocus
          spellCheck={false}
        />
        <button className={styles.submit} type="submit" disabled={auth.isPending || consoleCode.isPending || !code.trim()}>
          {auth.isPending ? 'Проверяю…' : consoleCode.isPending ? 'Запрашиваю…' : 'Войти'}
        </button>
        {consoleNotice ? <p className={styles.notice}>{consoleNotice}</p> : null}
        {auth.error ? <p className={styles.error}>{auth.error.message}</p> : null}
        {consoleCode.error ? <p className={styles.error}>{consoleCode.error.message}</p> : null}
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
