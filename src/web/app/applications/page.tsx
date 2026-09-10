'use client';

// The apps section: every app folder of the workspace (a folder with a
// balabash-app.json manifest) with its publication state. Lives at
// /applications — NOT /apps: that prefix belongs to the core (nginx routes
// /apps/* into the owner handoff towards the apps domain), which is exactly
// where the «open» links of this page lead.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { apiFetch } from '../../lib/api';
import { useAuthRedirect } from '../../lib/auth-gate';
import type {
  AppListingView,
  AppsResponse,
  PublicationResponse,
  PublishAppRequest,
  UnpublishAppRequest,
} from '../../../api/contract.ts';
import styles from './applications.module.css';

function encodePath(relPath: string): string {
  return relPath.split('/').map(encodeURIComponent).join('/');
}

type AppRowProps = {
  app: AppListingView;
  appsDomain: string | null;
};

function AppRow({ app, appsDomain }: AppRowProps) {
  const queryClient = useQueryClient();
  const [slugDraft, setSlugDraft] = useState('');
  const [publishing, setPublishing] = useState(false);

  const publish = useMutation({
    mutationFn: (body: PublishAppRequest) =>
      apiFetch<PublicationResponse>('/api/apps/publish', { method: 'POST', body }),
    onSuccess: () => {
      setPublishing(false);
      setSlugDraft('');
      queryClient.invalidateQueries({ queryKey: ['apps'] });
    },
  });

  const unpublish = useMutation({
    mutationFn: (body: UnpublishAppRequest) =>
      apiFetch<PublicationResponse>('/api/apps/unpublish', { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['apps'] }),
  });

  const busy = publish.isPending || unpublish.isPending;
  const error = publish.error ?? unpublish.error;
  const publicUrl = app.slug && appsDomain ? `https://${appsDomain}/${app.slug}` : null;

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.titleLine}>
          <span className={styles.name}>{app.name ?? app.path}</span>
          {app.manifestError ? (
            <span className={styles.badgeBroken}>манифест сломан</span>
          ) : app.slug ? (
            <span className={styles.badgePublic}>опубликовано</span>
          ) : (
            <span className={styles.badgePrivate}>не опубликовано</span>
          )}
        </div>

        <Link className={styles.path} href={`/workspace/${encodePath(app.path)}`}>
          {app.path}
        </Link>

        {app.description ? <p className={styles.desc}>{app.description}</p> : null}
        {app.manifestError ? <p className={styles.manifestError}>{app.manifestError}</p> : null}

        {app.slug ? (
          <p className={styles.slugLine}>
            публичный адрес:{' '}
            {publicUrl ? (
              <a href={publicUrl} target="_blank" rel="noreferrer">
                {publicUrl}
              </a>
            ) : (
              <code>/{app.slug}</code>
            )}
          </p>
        ) : null}

        {publishing ? (
          <form
            className={styles.publishForm}
            onSubmit={event => {
              event.preventDefault();
              publish.mutate({ path: app.path, slug: slugDraft.trim().toLowerCase() });
            }}
          >
            <input
              className={styles.slugInput}
              value={slugDraft}
              onChange={event => setSlugDraft(event.target.value)}
              placeholder="slug: a-z, 0-9, дефис"
              autoFocus
              disabled={busy}
            />
            <button className={styles.primary} type="submit" disabled={busy || !slugDraft.trim()}>
              {publish.isPending ? 'Публикую…' : 'Опубликовать'}
            </button>
            <button
              className={styles.secondary}
              type="button"
              disabled={busy}
              onClick={() => {
                setPublishing(false);
                publish.reset();
              }}
            >
              Отмена
            </button>
          </form>
        ) : null}

        {error ? <p className={styles.error}>{error.message}</p> : null}
      </div>

      <div className={styles.actions}>
        {/* A plain anchor: /apps/* is the core's handoff, not a Next route. */}
        {!app.manifestError ? (
          <a className={styles.open} href={`/apps/${encodePath(app.path)}`} target="_blank" rel="noreferrer">
            Открыть
          </a>
        ) : null}
        {app.slug ? (
          <button
            className={styles.secondary}
            type="button"
            disabled={busy}
            onClick={() => unpublish.mutate({ path: app.path })}
          >
            {unpublish.isPending ? 'Снимаю…' : 'Снять с публикации'}
          </button>
        ) : !app.manifestError && !publishing ? (
          <button className={styles.secondary} type="button" disabled={busy} onClick={() => setPublishing(true)}>
            Опубликовать
          </button>
        ) : null}
      </div>
    </li>
  );
}

export default function ApplicationsPage() {
  const apps = useQuery({
    queryKey: ['apps'],
    queryFn: () => apiFetch<AppsResponse>('/api/apps'),
  });

  const unauthorized = useAuthRedirect(apps.error);

  if (unauthorized || apps.isPending) {
    return (
      <main className={styles.main}>
        <p className={styles.dim}>Загрузка…</p>
      </main>
    );
  }

  return (
    <main className={styles.main}>
      <Link className={styles.back} href="/">
        ← Треды
      </Link>

      <header className={styles.header}>
        <h1 className={styles.title}>Приложения</h1>
        <p className={styles.hint}>
          Приложение — любая папка workspace с манифестом <code>balabash-app.json</code>.
        </p>
      </header>

      {apps.error ? <p className={styles.error}>Не удалось загрузить приложения: {apps.error.message}</p> : null}

      {apps.data && apps.data.apps.length === 0 ? <p className={styles.dim}>Приложений пока нет.</p> : null}

      {apps.data ? (
        <ul className={styles.list}>
          {apps.data.apps.map(app => (
            <AppRow key={app.path} app={app} appsDomain={apps.data.appsDomain ?? null} />
          ))}
        </ul>
      ) : null}
    </main>
  );
}
