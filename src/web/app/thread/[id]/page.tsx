'use client';

// The thread page, two tabs. «Чат» (default): the readable dialogue of the
// thread — user and agent messages as Markdown, the thread's own lifecycle
// and the child threads' as thin lines in between, a composer at the bottom
// that appends a user.message through the API. The feed is a live tail: the
// newest page first, then ?after=<seq> polled every couple of seconds;
// «Раньше» pages into older events by ?before=. «События»: the full event
// feed, newest first, whole events with the payload as honest raw JSON.
// Ownership is the server's business: a foreign or missing id is the same
// 404.
//
// A headless thread has no user surface by declaration: its chat is the
// read-only dialogue with the parent (the task, thread.message both ways,
// progress, the summary) and the composer is not drawn.

import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Markdown } from '../../../components/Markdown';
import { ApiError, apiFetch } from '../../../lib/api';
import { useAuthRedirect } from '../../../lib/auth-gate';
import { STATUS_LABELS, formatDateTime } from '../../../lib/format';
import type {
  ContentBlock,
  Event,
  PostThreadMessageRequest,
  PostThreadMessageResponse,
  Thread,
  ThreadEventsResponse,
  ThreadResponse,
} from '../../../../api/contract.ts';
import styles from './thread.module.css';

const EVENTS_PAGE_SIZE = 100;
const CHAT_PAGE_SIZE = 200;
const CHAT_POLL_MS = 2000;

type Tab = 'chat' | 'events';

// ---------------------------------------------------------------------------
// The events tab: whole events, newest first.

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

function EventsTab({ threadId }: { threadId: string }) {
  const events = useInfiniteQuery({
    queryKey: ['thread-events', threadId],
    queryFn: ({ pageParam }) =>
      apiFetch<ThreadEventsResponse>(
        `/api/threads/${threadId}/events?limit=${EVENTS_PAGE_SIZE}${pageParam ? `&before=${pageParam}` : ''}`,
      ),
    initialPageParam: '',
    // nextCursor = seq of the oldest event on a full page; the server's
    // strict `before` guarantees no duplicates even for equal timestamps.
    getNextPageParam: lastPage => (lastPage.nextCursor !== null ? String(lastPage.nextCursor) : null),
  });

  const unauthorized = useAuthRedirect(events.error);
  const allEvents = events.data?.pages.flatMap(page => page.events) ?? [];

  return (
    <>
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
    </>
  );
}

// ---------------------------------------------------------------------------
// The chat tab: events → readable items.

type FileMeta = { fileId: string; originalFilename: string | null; contentType: string | null };

type ChatItem =
  | {
      kind: 'message';
      key: string;
      // user — the human; agent — this thread's agent; parent — the parent
      // thread speaking to this one (the task, operator messages); report —
      // this thread speaking to its parent (headless replies, the summary).
      who: 'user' | 'agent' | 'parent' | 'report';
      label: string;
      at: Date;
      text: string;
      blocks: ContentBlock[];
      files: FileMeta[];
    }
  | { kind: 'line'; key: string; at: Date; text: string; href?: string; tone: 'dim' | 'ok' | 'bad' };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function identityLabel(identity: unknown): string {
  const object = asRecord(identity);
  const name = [object.firstName, object.lastName]
    .filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))
    .join(' ');
  const username = typeof object.username === 'string' && object.username ? `@${object.username}` : '';

  return name && username ? `${name} (${username})` : name || username || 'Пользователь';
}

function fileMetas(value: unknown): FileMeta[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(item => {
    const meta = asRecord(item);

    return typeof meta.fileId === 'string'
      ? [
          {
            fileId: meta.fileId,
            originalFilename: typeof meta.originalFilename === 'string' ? meta.originalFilename : null,
            contentType: typeof meta.contentType === 'string' ? meta.contentType : null,
          },
        ]
      : [];
  });
}

function fileIdsToMetas(value: unknown): FileMeta[] {
  return Array.isArray(value)
    ? value
        .filter((id): id is string => typeof id === 'string' && Boolean(id))
        .map(fileId => ({ fileId, originalFilename: null, contentType: null }))
    : [];
}

function contentBlocks(value: unknown): ContentBlock[] {
  return Array.isArray(value)
    ? value.filter((block): block is ContentBlock => typeof asRecord(block).type === 'string')
    : [];
}

function short(id: string): string {
  return `${id.slice(0, 8)}…`;
}

// One event of the thread's feed as a chat item, or null when it is not part
// of the dialogue (tool calls, catalog events, the children's internals).
// Direction is read from the envelope: threadId is the author thread,
// targetThreadId the addressee — a child's event lands here when addressed
// to this thread.
function toChatItem(event: Event, thread: Thread): ChatItem | null {
  const payload = asRecord(event.payload);
  const own = event.threadId === thread.id;
  const key = event.id;
  const at = event.createdAt;
  const other = own ? event.targetThreadId : event.threadId;
  const otherHref = other ? `/thread/${other}` : undefined;
  const otherLabel = event.agentName ?? (other ? short(other) : '');

  switch (event.type) {
    case 'user.message':
      return own
        ? {
            kind: 'message',
            key,
            who: 'user',
            label: identityLabel(payload.identity),
            at,
            text: asString(payload.text),
            blocks: [],
            files: fileMetas(payload.files),
          }
        : null;

    case 'agent.message':
      return own
        ? {
            kind: 'message',
            key,
            who: 'agent',
            label: event.agentName ?? thread.agent,
            at,
            text: '',
            blocks: contentBlocks(payload.content),
            files: [],
          }
        : null;

    case 'thread.started': {
      if (!own) {
        return {
          kind: 'line',
          key,
          at,
          text: `▶ запущен тред ${otherLabel}: ${asString(payload.title) || short(event.threadId ?? '')}`,
          href: event.threadId ? `/thread/${event.threadId}` : undefined,
          tone: 'dim',
        };
      }

      const input = asString(payload.input);

      if (thread.parentId && input) {
        return { kind: 'message', key, who: 'parent', label: 'Задание', at, text: input, blocks: [], files: [] };
      }

      return { kind: 'line', key, at, text: thread.parentId ? 'тред создан' : 'главный тред создан', tone: 'dim' };
    }

    case 'thread.message': {
      const text = asString(payload.text);
      const files = fileIdsToMetas(payload.fileIds);

      if (!own && event.threadId === thread.parentId) {
        return { kind: 'message', key, who: 'parent', label: 'Оператор (родительский тред)', at, text, blocks: [], files };
      }

      if (own && event.targetThreadId === thread.parentId) {
        return { kind: 'message', key, who: 'report', label: `${event.agentName ?? thread.agent} → родителю`, at, text, blocks: [], files };
      }

      // Between this thread and one of its children: a line, the child page
      // has the whole exchange.
      return {
        kind: 'line',
        key,
        at,
        text: own ? `→ ${otherLabel}: ${text}` : `← ${otherLabel}: ${text}`,
        href: otherHref,
        tone: 'dim',
      };
    }

    case 'thread.progress':
      return {
        kind: 'line',
        key,
        at,
        text: own ? `прогресс: ${asString(payload.text)}` : `прогресс ${otherLabel}: ${asString(payload.text)}`,
        href: own ? undefined : otherHref,
        tone: 'dim',
      };

    case 'thread.completed':
    case 'thread.failed':
    case 'thread.cancelled': {
      const tone = event.type === 'thread.completed' ? 'ok' : 'bad';
      const title = asString(payload.title);
      const outcome =
        event.type === 'thread.completed'
          ? 'завершён'
          : event.type === 'thread.failed'
            ? `ошибка${asString(payload.error) ? `: ${asString(payload.error)}` : ''}`
            : 'отменён';

      if (!own) {
        return {
          kind: 'line',
          key,
          at,
          text: `■ тред ${otherLabel} ${outcome}${title ? ` — ${title}` : ''}`,
          href: event.threadId ? `/thread/${event.threadId}` : undefined,
          tone,
        };
      }

      const summary = asRecord(payload.summary);
      const summaryText = asString(summary.text);

      // The summary is the thread's handoff to its parent — for a headless
      // thread the one message it ever leaves behind: a message, not a line.
      if (summaryText) {
        return {
          kind: 'message',
          key,
          who: 'report',
          label: `Итог${title ? `: ${title}` : ''}`,
          at,
          text: summaryText,
          blocks: [],
          files: fileIdsToMetas(summary.fileIds),
        };
      }

      return { kind: 'line', key, at, text: `тред ${outcome}${title ? ` — ${title}` : ''}`, tone };
    }

    case 'thread.cancel':
      return { kind: 'line', key, at, text: own ? 'отмена' : `отмена → ${otherLabel}`, tone: 'dim' };

    case 'thread.interrupt':
      return { kind: 'line', key, at, text: 'стоп (прервать текущий ход)', tone: 'dim' };

    case 'thread.notification': {
      const text = asString(payload.text) || asString(payload.message);

      return text ? { kind: 'line', key, at, text: own ? text : `${otherLabel}: ${text}`, href: own ? undefined : otherHref, tone: 'dim' } : null;
    }

    default:
      return null;
  }
}

// Only web schemes survive as links; everything else (javascript:, data:,
// file:, relative paths) renders as text.
function safeExternalHref(uri: unknown): string | null {
  if (typeof uri !== 'string') {
    return null;
  }

  try {
    const url = new URL(uri);

    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

function fileHref(fileId: string, download = false): string {
  return `/api/files/${encodeURIComponent(fileId)}${download ? '?download=1' : ''}`;
}

function FileLinks({ files }: { files: FileMeta[] }) {
  if (!files.length) {
    return null;
  }

  return (
    <ul className={styles.files}>
      {files.map(file =>
        file.contentType?.startsWith('image/') ? (
          <li key={file.fileId}>
            <a href={fileHref(file.fileId)} target="_blank" rel="noreferrer">
              <img className={styles.image} src={fileHref(file.fileId)} alt={file.originalFilename ?? file.fileId} />
            </a>
          </li>
        ) : (
          <li key={file.fileId}>
            <a href={fileHref(file.fileId, true)}>📎 {file.originalFilename ?? short(file.fileId)}</a>
          </li>
        ),
      )}
    </ul>
  );
}

function Blocks({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'text':
            return <Markdown key={index}>{block.text}</Markdown>;
          case 'image':
            return (
              <a key={index} href={fileHref(block.fileId)} target="_blank" rel="noreferrer">
                <img className={styles.image} src={fileHref(block.fileId)} alt="" />
              </a>
            );
          case 'file':
            return (
              <p key={index} className={styles.attachment}>
                <a href={fileHref(block.fileId, true)}>📎 файл {short(block.fileId)}</a>
              </p>
            );
          case 'resource_link': {
            // The uri comes from a tool result (an external MCP server's
            // answer): only web schemes become a link, anything else is text.
            const href = safeExternalHref(block.uri);

            return (
              <p key={index} className={styles.attachment}>
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    🔗 {block.name ?? block.uri}
                  </a>
                ) : (
                  <span>🔗 {block.name ?? block.uri}</span>
                )}
              </p>
            );
          }
          default:
            return null;
        }
      })}
    </>
  );
}

function ChatItemView({ item }: { item: ChatItem }) {
  if (item.kind === 'line') {
    const text = item.href ? <Link href={item.href}>{item.text}</Link> : item.text;

    return (
      <li className={`${styles.line} ${styles[`line_${item.tone}`]}`}>
        <span className={styles.lineText}>{text}</span>
        <span className={styles.lineTime}>{formatDateTime(item.at)}</span>
      </li>
    );
  }

  return (
    <li className={`${styles.message} ${styles[`message_${item.who}`]}`}>
      <div className={styles.messageHeader}>
        <span className={styles.messageLabel}>{item.label}</span>
        <span className={styles.messageTime}>{formatDateTime(item.at)}</span>
      </div>
      {item.text ? <Markdown>{item.text}</Markdown> : null}
      {item.blocks.length ? <Blocks blocks={item.blocks} /> : null}
      <FileLinks files={item.files} />
    </li>
  );
}

// The live feed: the newest page on mount, older pages on demand, the tail
// polled by the seq of the last event we hold. Events are kept ascending
// and deduplicated by seq — a sent message lands in the list right away and
// the poll that brings it back is a no-op.
function useChatFeed(threadId: string) {
  const [events, setEvents] = useState<Event[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const eventsRef = useRef(events);

  eventsRef.current = events;

  const merge = useCallback((incoming: Event[]) => {
    if (!incoming.length) {
      return;
    }

    setEvents(current => {
      const known = new Set(current.map(event => String(event.seq)));
      const fresh = incoming.filter(event => !known.has(String(event.seq)));

      return fresh.length ? [...current, ...fresh].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0)) : current;
    });
  }, []);

  const head = useQuery({
    queryKey: ['thread-chat-head', threadId],
    queryFn: () => apiFetch<ThreadEventsResponse>(`/api/threads/${threadId}/events?limit=${CHAT_PAGE_SIZE}`),
    gcTime: 0,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (head.data && !loaded) {
      merge(head.data.events);
      setExhausted(head.data.nextCursor === null);
      setLoaded(true);
    }
  }, [head.data, loaded, merge]);

  const tail = useQuery({
    queryKey: ['thread-chat-tail', threadId],
    queryFn: () => {
      const last = eventsRef.current.at(-1);

      return apiFetch<ThreadEventsResponse>(
        `/api/threads/${threadId}/events?after=${last ? String(last.seq) : '0'}&limit=${CHAT_PAGE_SIZE}`,
      );
    },
    enabled: loaded,
    gcTime: 0,
    refetchInterval: CHAT_POLL_MS,
  });

  useEffect(() => {
    if (tail.data) {
      merge(tail.data.events);
    }
  }, [tail.data, merge]);

  const loadOlder = useCallback(async () => {
    const first = eventsRef.current[0];

    if (!first || loadingOlder) {
      return;
    }

    setLoadingOlder(true);

    try {
      const page = await apiFetch<ThreadEventsResponse>(
        `/api/threads/${threadId}/events?before=${String(first.seq)}&limit=${CHAT_PAGE_SIZE}`,
      );

      merge(page.events);
      setExhausted(page.nextCursor === null);
    } finally {
      setLoadingOlder(false);
    }
  }, [threadId, loadingOlder, merge]);

  return { events, loaded, error: head.error ?? tail.error, exhausted, loadingOlder, loadOlder, merge };
}

function ChatTab({ thread, headless }: { thread: Thread; headless: boolean }) {
  const feed = useChatFeed(thread.id);
  const unauthorized = useAuthRedirect(feed.error);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const canWrite = thread.status === 'active' && !headless;

  const send = useMutation({
    mutationFn: (body: PostThreadMessageRequest) =>
      apiFetch<PostThreadMessageResponse>(`/api/threads/${thread.id}/messages`, { method: 'POST', body }),
    onSuccess: response => {
      setDraft('');
      stickToBottom.current = true;
      feed.merge([response.event]);
    },
  });

  // Follow the tail while the reader is at the bottom; leave them alone once
  // they scrolled up to read.
  useEffect(() => {
    const onScroll = () => {
      stickToBottom.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120;
    };

    window.addEventListener('scroll', onScroll, { passive: true });

    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [feed.events]);

  function submit(event?: FormEvent) {
    event?.preventDefault();

    const text = draft.trim();

    if (text && !send.isPending && canWrite) {
      send.mutate({ text });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  const items = feed.events.map(event => toChatItem(event, thread)).filter((item): item is ChatItem => item !== null);

  return (
    <>
      {headless ? (
        <p className={styles.notice}>
          Headless-тред: агент говорит только со своим оператором — родительским тредом. Здесь этот диалог только для
          чтения, сообщения сюда не принимаются.
        </p>
      ) : null}

      {!feed.exhausted && feed.loaded ? (
        <button className={styles.more} type="button" disabled={feed.loadingOlder} onClick={() => void feed.loadOlder()}>
          {feed.loadingOlder ? 'Загружаю…' : 'Раньше'}
        </button>
      ) : null}

      {!feed.loaded ? <p className={styles.dim}>Загрузка…</p> : null}
      {feed.error && !unauthorized ? <p className={styles.error}>Не удалось загрузить чат: {feed.error.message}</p> : null}
      {feed.loaded && items.length === 0 ? <p className={styles.dim}>Сообщений пока нет.</p> : null}

      <ul className={styles.chat}>
        {items.map(item => (
          <ChatItemView key={item.key} item={item} />
        ))}
      </ul>
      <div ref={bottomRef} />

      {canWrite ? (
        <form className={styles.composer} onSubmit={submit}>
          <textarea
            className={styles.input}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Сообщение… (Enter — отправить, Shift+Enter — перенос строки)"
            rows={3}
            disabled={send.isPending}
          />
          <div className={styles.composerRow}>
            {send.error ? <span className={styles.error}>{send.error.message}</span> : <span />}
            <button className={styles.send} type="submit" disabled={send.isPending || !draft.trim()}>
              {send.isPending ? 'Отправляю…' : 'Отправить'}
            </button>
          </div>
        </form>
      ) : !headless && thread.status !== 'active' ? (
        <p className={styles.notice}>Тред {STATUS_LABELS[thread.status]} — новые сообщения не принимаются.</p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------

export default function ThreadPage() {
  const params = useParams<{ id: string }>();
  const threadId = params.id;
  const [tab, setTab] = useState<Tab>('chat');

  const thread = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => apiFetch<ThreadResponse>(`/api/threads/${threadId}`),
    // The status flips when the thread ends; keep the header honest.
    refetchInterval: 10_000,
  });

  const unauthorized = useAuthRedirect(thread.error);
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

  return (
    <main className={styles.main}>
      <Link className={styles.back} href="/">
        ← Треды
      </Link>

      <header className={styles.header}>
        <h1 className={styles.title}>{info.title ?? info.id}</h1>
        <div className={styles.meta}>
          <span className={styles.agent}>{info.agent}</span>
          {info.parentId === null ? <span className={styles.badge}>главный</span> : null}
          {thread.data.headless ? <span className={styles.badge}>headless</span> : null}
          <span className={`${styles.status} ${styles[`status_${info.status}`]}`}>{STATUS_LABELS[info.status]}</span>
          <span className={styles.time}>
            {formatDateTime(info.createdAt)}
            {info.updatedAt.getTime() !== info.createdAt.getTime() ? ` → ${formatDateTime(info.updatedAt)}` : ''}
          </span>
          {info.parentId ? (
            <Link className={styles.parentLink} href={`/thread/${info.parentId}`}>
              ↑ родительский тред
            </Link>
          ) : null}
        </div>
      </header>

      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'chat'}
          className={tab === 'chat' ? styles.tabActive : styles.tab}
          onClick={() => setTab('chat')}
        >
          Чат
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'events'}
          className={tab === 'events' ? styles.tabActive : styles.tab}
          onClick={() => setTab('events')}
        >
          События
        </button>
      </div>

      {tab === 'chat' ? <ChatTab thread={info} headless={thread.data.headless} /> : <EventsTab threadId={threadId} />}
    </main>
  );
}
