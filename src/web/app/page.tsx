'use client';

// The workspace window, page one: the thread list. Newest first, filtered by
// status, paginated by createdAt cursor («показать ещё» loads older ones).

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useAuthRedirect } from '../lib/auth-gate';
import { STATUS_LABELS, formatDateTime } from '../lib/format';
import type { LogoutResponse, MeResponse, Thread, ThreadStatus, ThreadsResponse } from '../../api/contract.ts';
import styles from './page.module.css';

const PAGE_SIZE = 50;

type StatusFilter = ThreadStatus | 'all';

const FILTERS: StatusFilter[] = ['all', 'active', 'completed', 'failed', 'cancelled'];

async function fetchThreads(status: StatusFilter, createdAtLte: string | null): Promise<Thread[]> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });

  if (status !== 'all') {
    params.set('status', status);
  }

  if (createdAtLte !== null) {
    params.set('createdAtLte', createdAtLte);
  }

  const { threads } = await apiFetch<ThreadsResponse>(`/api/threads?${params}`);

  // The API returns the newest window in creation order; the list shows
  // newest first.
  return threads.slice().reverse();
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
    // A full page continues from its oldest thread's createdAt (inclusive on
    // the server; the flatten below dedups the boundary thread by id).
    getNextPageParam: lastPage =>
      lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1]!.createdAt.toISOString() : null,
  });

  const unauthorized = useAuthRedirect(me.error, threads.error);

  const logout = useMutation({
    mutationFn: () => apiFetch<LogoutResponse>('/api/logout', { method: 'POST' }),
    onSuccess: () => {
      queryClient.clear();
      router.replace('/login');
    },
  });

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const result: Thread[] = [];

    for (const page of threads.data?.pages ?? []) {
      for (const thread of page) {
        if (!seen.has(thread.id)) {
          seen.add(thread.id);
          result.push(thread);
        }
      }
    }

    return result;
  }, [threads.data]);

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
        <button
          className={styles.logout}
          type="button"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
        >
          Выйти
        </button>
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
