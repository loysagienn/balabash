// Hello world of the console: proves the host, the bundle pipeline and the
// session cookie end to end — GET /api/me tells whether a session exists on
// this host, POST /api/auth exchanges a one-time code for one, POST
// /api/logout drops it. The screens of the design come later; nothing here
// is meant to survive them.

import { useEffect, useState, type FormEvent } from 'react';
import type { AuthRequest, LogoutResponse, MeResponse } from '../api/contract.ts';
import { ApiError, apiFetch } from './lib/api.ts';

type SessionState = { kind: 'loading' } | { kind: 'anonymous' } | { kind: 'signed-in'; me: MeResponse } | { kind: 'error'; message: string };

function buildStamp(): string | null {
  return document.querySelector('meta[name="console-build"]')?.getAttribute('content') ?? null;
}

export function App() {
  const [session, setSession] = useState<SessionState>({ kind: 'loading' });

  async function refresh(): Promise<void> {
    try {
      const me = await apiFetch<MeResponse>('/api/me');

      setSession({ kind: 'signed-in', me });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSession({ kind: 'anonymous' });
      } else {
        setSession({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <main className="solo">
      <h1 className="brand">Balabash</h1>
      <p className="muted">
        console · host <code>{window.location.host}</code>
        {buildStamp() ? (
          <>
            {' '}
            · build <code>{buildStamp()}</code>
          </>
        ) : null}
      </p>

      {session.kind === 'loading' && <p>Проверяю сессию…</p>}
      {session.kind === 'error' && <p className="err">Ошибка: {session.message}</p>}
      {session.kind === 'anonymous' && <LoginForm onSignedIn={me => setSession({ kind: 'signed-in', me })} />}
      {session.kind === 'signed-in' && <SignedIn me={session.me} onSignedOut={() => setSession({ kind: 'anonymous' })} />}
    </main>
  );
}

function LoginForm({ onSignedIn }: { onSignedIn: (me: MeResponse) => void }) {
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();

    const trimmed = code.trim();

    if (!trimmed || pending) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      const body: AuthRequest = { code: trimmed };
      const me = await apiFetch<MeResponse>('/api/auth', { method: 'POST', body });

      onSignedIn(me);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <p>
        Сессии на этом хосте нет. Введите одноразовый код (в Telegram — <code>/auth_code</code>).
      </p>
      <label>
        Код
        <input
          autoFocus
          autoComplete="one-time-code"
          spellCheck={false}
          value={code}
          onChange={event => setCode(event.target.value)}
          disabled={pending}
        />
      </label>
      <button type="submit" disabled={pending || !code.trim()}>
        {pending ? 'Вхожу…' : 'Войти'}
      </button>
      {error && <p className="err">{error}</p>}
    </form>
  );
}

function SignedIn({ me, onSignedOut }: { me: MeResponse; onSignedOut: () => void }) {
  const [pending, setPending] = useState(false);

  async function logout(): Promise<void> {
    setPending(true);

    try {
      await apiFetch<LogoutResponse>('/api/logout', { method: 'POST' });
      onSignedOut();
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card">
      <p>
        Hello, world — сессия есть. Рабочее пространство: <b>{me.workspaceName ?? '—'}</b>
      </p>
      <dl>
        <dt>userId</dt>
        <dd>
          <code>{me.userId}</code>
        </dd>
        <dt>mainThreadId</dt>
        <dd>
          <code>{me.mainThreadId ?? '—'}</code>
        </dd>
      </dl>
      <button type="button" onClick={() => void logout()} disabled={pending}>
        Выйти
      </button>
    </section>
  );
}
