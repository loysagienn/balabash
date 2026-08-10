'use client';

// The thread page: the full event feed of one thread, oldest first, whole
// events with the payload as honest raw JSON. «Показать ещё» continues by
// the seq cursor. Ownership is the server's business: a foreign or missing
// id is the same 404.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ApiError, apiFetch } from '../../../lib/api';
import { useAuthRedirect } from '../../../lib/auth-gate';
import { STATUS_LABELS, formatDateTime } from '../../../lib/format';
import type { Event, ThreadEventsResponse, ThreadResponse } from '../../../../api/contract.ts';
import styles from './thread.module.css';

const EVENTS_PAGE_SIZE = 100;

function EventCard({ event }: { event: Event }) {
  return (
    <li className={styles.event}>
      <div className={styles.eventHeader}>
        <span className={styles.seq}>#{String(event.seq)}</span>
        <span className={styles.type}>{event.type}</span>
        <span className={styles.actor}>
          {event.actor}
          {event.agentName ? `:${event.agentName}` : ''}
        </span>
        {event.targetThreadId ? <span className={styles.target}>→ {event.targetThreadId.slice(0, 8)}…</span> : null}
        <span className={styles.time}>{formatDateTime(event.createdAt)}</span>
      </div>
      <pre className={styles.payload}>{JSON.stringify(event.payload, null, 2)}</pre>
    </li>
  );
}

export default function ThreadPage() {
  const params = useParams<{ id: string }>();
  const threadId = params.id;

  const thread = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => apiFetch<ThreadResponse>(`/api/threads/${threadId}`),
  });

  const events = useInfiniteQuery({
    queryKey: ['thread-events', threadId],
    queryFn: ({ pageParam }) =>
      apiFetch<ThreadEventsResponse>(
        `/api/threads/${threadId}/events?limit=${EVENTS_PAGE_SIZE}${pageParam ? `&after=${pageParam}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: lastPage => (lastPage.nextCursor !== null ? String(lastPage.nextCursor) : null),
  });

  const unauthorized = useAuthRedirect(thread.error, events.error);

  const notFound = thread.error instanceof ApiError && thread.error.status === 404;

  if (unauthorized || thread.isPending) {
    return (
      <main className={styles.main}>
        <p className={styles.dim}>Загрузка…</p>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className={styles.main}>
        <Link className={styles.back} href="/">
          ← Треды
        </Link>
        <p className={styles.error}>Такого треда нет.</p>
      </main>
    );
  }

  if (thread.error) {
    return (
      <main className={styles.main}>
        <Link className={styles.back} href="/">
          ← Треды
        </Link>
        <p className={styles.error}>Не удалось загрузить тред: {thread.error.message}</p>
      </main>
    );
  }

  const info = thread.data.thread;
  const allEvents = events.data?.pages.flatMap(page => page.events) ?? [];

  return (
    <main className={styles.main}>
      <Link className={styles.back} href="/">
        ← Треды
      </Link>

      <header className={styles.header}>
        <h1 className={styles.title}>{info.title ?? info.id}</h1>
        <div className={styles.meta}>
          <span className={styles.agent}>{info.agent}</span>
          <span className={`${styles.status} ${styles[`status_${info.status}`]}`}>{STATUS_LABELS[info.status]}</span>
          <span className={styles.time}>
            {formatDateTime(info.createdAt)}
            {info.updatedAt.getTime() !== info.createdAt.getTime() ? ` → ${formatDateTime(info.updatedAt)}` : ''}
          </span>
        </div>
      </header>

      {events.isPending ? <p className={styles.dim}>Загрузка событий…</p> : null}
      {events.error && !unauthorized ? (
        <p className={styles.error}>Не удалось загрузить события: {events.error.message}</p>
      ) : null}
      {events.data && allEvents.length === 0 ? <p className={styles.dim}>Событий нет.</p> : null}

      <ul className={styles.events}>
        {allEvents.map(event => (
          <EventCard key={event.id} event={event} />
        ))}
      </ul>

      {events.hasNextPage ? (
        <button
          className={styles.more}
          type="button"
          disabled={events.isFetchingNextPage}
          onClick={() => events.fetchNextPage()}
        >
          {events.isFetchingNextPage ? 'Загружаю…' : 'Показать ещё'}
        </button>
      ) : null}
    </main>
  );
}
