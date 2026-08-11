'use client';

// The workspace window, page one: the thread list. Newest first, filtered by
// status, cursor-paginated by createdSeq («показать ещё» loads older ones).

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from '../lib/api';
import { useAuthRedirect } from '../lib/auth-gate';
import { STATUS_LABELS, formatDateTime } from '../lib/format';
import type { LogoutResponse, MeResponse, ThreadStatus, ThreadsResponse } from '../../api/contract.ts';
import styles from './page.module.css';

const PAGE_SIZE = 50;

type StatusFilter = ThreadStatus | 'all';

const FILTERS: StatusFilter[] = ['all', 'active', 'completed', 'failed', 'cancelled'];

async function fetchThreads(status: StatusFilter, before: string | null): Promise<ThreadsResponse> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });

  if (status !== 'all') {
    params.set('status', status);
  }

  if (before !== null) {
    params.set('before', before);
  }

  return apiFetch<ThreadsResponse>(`/api/threads?${params}`);
}

export default function HomePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<StatusFilter>('all');

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<MeResponse>('/api/me'),
  });

  const threads = useInfiniteQuery({
    queryKey: ['threads', filter],
    queryFn: ({ pageParam }) => fetchThreads(filter, pageParam),
    initialPageParam: null as string | null,
    // The server's cursor (createdSeq of the oldest returned thread) is
    // strict, so pages never overlap — no client-side dedup needed.
    getNextPageParam: lastPage => (lastPage.nextCursor !== null ? String(lastPage.nextCursor) : null),
  });

  const unauthorized = useAuthRedirect(me.error, threads.error);

  const logout = useMutation({
    mutationFn: () => apiFetch<LogoutResponse>('/api/logout', { method: 'POST' }),
    onSuccess: () => {
      queryClient.clear();
      router.replace('/login');
    },
  });

  const rows = threads.data?.pages.flatMap(page => page.threads) ?? [];

  if (unauthorized || me.isPending) {
    return (
      <main className={styles.main}>
        <p className={styles.dim}>Загрузка…</p>
      </main>
    );
  }

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.title}>{me.data?.workspaceName ?? 'Balabash'}</h1>
        <div className={styles.headerActions}>
          {me.data?.mainThreadId ? (
            <Link className={styles.coordinator} href={`/thread/${me.data.mainThreadId}`}>
              Координатор
            </Link>
          ) : null}
          <button
            className={styles.logout}
            type="button"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            Выйти
          </button>
        </div>
      </header>

      <div className={styles.filters}>
        {FILTERS.map(value => (
          <button
            key={value}
            type="button"
            className={value === filter ? styles.filterActive : styles.filter}
            onClick={() => setFilter(value)}
          >
            {value === 'all' ? 'все' : STATUS_LABELS[value]}
          </button>
        ))}
      </div>

      {threads.isPending ? <p className={styles.dim}>Загрузка тредов…</p> : null}
      {threads.error && !unauthorized ? (
        <p className={styles.error}>Не удалось загрузить треды: {threads.error.message}</p>
      ) : null}
      {threads.data && rows.length === 0 ? <p className={styles.dim}>Тредов нет.</p> : null}

      <ul className={styles.list}>
        {rows.map(thread => (
          <li key={thread.id}>
            <Link className={styles.row} href={`/thread/${thread.id}`}>
              <span className={styles.agent}>{thread.agent}</span>
              <span className={styles.threadTitle}>{thread.title ?? thread.id}</span>
              <span className={`${styles.status} ${styles[`status_${thread.status}`]}`}>
                {STATUS_LABELS[thread.status]}
              </span>
              <span className={styles.times}>
                {formatDateTime(thread.createdAt)}
                {thread.updatedAt.getTime() !== thread.createdAt.getTime()
                  ? ` → ${formatDateTime(thread.updatedAt)}`
                  : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {threads.hasNextPage ? (
        <button
          className={styles.more}
          type="button"
          disabled={threads.isFetchingNextPage}
          onClick={() => threads.fetchNextPage()}
        >
          {threads.isFetchingNextPage ? 'Загружаю…' : 'Показать ещё'}
        </button>
      ) : null}
    </main>
  );
}
