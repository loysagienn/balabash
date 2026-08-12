// gmail-new-mail — every 10 minutes: fetch Gmail messages that arrived since
// the last pushed event (window capped at 1 hour back from now) and push a
// schedule.fired event listing them. No new mail → no event.
//
// The search reaches 5 minutes behind the watermark (overlap) so a message
// whose search-index entry lagged past the previous run is still caught;
// messages already listed in recent events are deduplicated by messageId.

import type { TaskContext } from '../src/schedule/contract.ts';

const SLUG = 'gmail-new-mail';
const MAX_WINDOW_MS = 60 * 60 * 1000; // never look back more than 1 hour
const OVERLAP_MS = 5 * 60 * 1000; // re-scan behind the watermark (index lag)
const PAGE_SIZE = 25; // gmail_search_emails max per page
const MAX_PAGES = 10; // safety cap: 250 messages per run is already absurd
const DEDUP_EVENTS = 5; // recent events whose messageIds count as "seen"

type SearchMessage = {
  message_id?: string;
  date?: string;
  from?: string;
  subject?: string;
  snippet?: string;
  label_ids?: string[];
};

type SearchResult = {
  messages?: SearchMessage[];
  next_page_token?: string;
};

// Newsletter snippets are padded with invisible characters (zero-width
// joiners, combining grapheme joiner, soft hyphens…) to control the Gmail
// preview line — strip them and collapse whitespace.
function cleanSnippet(raw: string): string {
  return raw
    .replace(/[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Watermark of the previous run — the `until` of the last event this task
// pushed (fallback: the event's createdAt), null when there is no prior event —
// plus the messageIds listed in the last few events, so the overlap re-scan
// does not report the same message twice.
async function getWatermark(ctx: TaskContext): Promise<{ lastInstant: number | null; seen: Set<string> }> {
  const events = await ctx.prisma.event.findMany({
    where: { type: 'schedule.fired', payload: { path: ['slug'], equals: SLUG } },
    orderBy: { seq: 'desc' },
    take: DEDUP_EVENTS,
  });

  const seen = new Set<string>();

  for (const event of events) {
    const payload = event.payload as { newMessages?: unknown };

    if (Array.isArray(payload.newMessages)) {
      for (const message of payload.newMessages as { messageId?: unknown }[]) {
        if (typeof message.messageId === 'string' && message.messageId) {
          seen.add(message.messageId);
        }
      }
    }
  }

  const last = events[0];

  if (!last) {
    return { lastInstant: null, seen };
  }

  const payload = last.payload as { until?: unknown };
  const until = typeof payload.until === 'string' ? Date.parse(payload.until) : NaN;

  return { lastInstant: Number.isNaN(until) ? last.createdAt.getTime() : until, seen };
}

export async function run(ctx: TaskContext): Promise<void> {
  const now = Date.now();
  const { lastInstant, seen } = await getWatermark(ctx);
  // "Not before the last event, never deeper than an hour" — then reach the
  // overlap further back; dedup by messageId keeps the overlap duplicate-free.
  const watermark = Math.max(lastInstant ?? 0, now - MAX_WINDOW_MS);
  const since = watermark - OVERLAP_MS;
  const until = now;

  // Gmail's after: takes epoch seconds (second precision, fuzzy boundary) —
  // it narrows the search; the exact window is enforced by the ms filter below.
  const query = `after:${Math.floor(since / 1000)}`;

  const fresh: SearchMessage[] = [];
  let pageToken: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const outcome = await ctx.tools.call('gmail_search_emails', {
      query,
      max_results: PAGE_SIZE,
      ...(pageToken ? { page_token: pageToken } : {}),
    });

    if (outcome.isError) {
      throw new Error(`gmail_search_emails failed: ${JSON.stringify(outcome.structuredContent ?? outcome.content)}`);
    }

    const result = (outcome.structuredContent ?? {}) as SearchResult;
    const messages = result.messages ?? [];
    // Results come newest-first: once a page dips below `since`, older pages
    // have nothing for us.
    let reachedOlder = false;

    for (const message of messages) {
      const date = typeof message.date === 'string' ? Date.parse(message.date) : NaN;

      if (Number.isNaN(date)) {
        continue;
      }

      if (date <= since) {
        reachedOlder = true;
        continue;
      }

      // A message that lands mid-run with date > until belongs to the next
      // window; one already listed in a recent event is the overlap re-scan.
      if (date <= until && !(message.message_id && seen.has(message.message_id))) {
        fresh.push(message);
      }
    }

    pageToken = result.next_page_token || undefined;

    if (reachedOlder || !pageToken) {
      break;
    }

    if (page === MAX_PAGES - 1) {
      truncated = true;
    }
  }

  if (fresh.length === 0) {
    return; // nothing new — leave no trace
  }

  // Oldest first reads naturally in the event.
  fresh.sort((a, b) => Date.parse(a.date ?? '') - Date.parse(b.date ?? ''));

  await ctx.pushEvent({
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    count: fresh.length,
    ...(truncated ? { truncated: true } : {}),
    newMessages: fresh.map(message => ({
      messageId: message.message_id ?? '',
      date: message.date ?? '',
      from: message.from ?? '',
      subject: message.subject ?? '',
      snippet: cleanSnippet(message.snippet ?? ''),
      labels: message.label_ids ?? [],
    })),
  });
}
