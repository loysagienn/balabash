// The replacement for the installation's known TaskContext module. This is
// program source, stored in the registry and run by the ordinary task runner.
export const gmailNewMail = String.raw`
const root = await describe('');
if (!root.children.some(child => child.name === 'gmail')) return null;
const { accounts } = await describe('gmail_search_emails');
const until = Date.now();
const history = await call('schedule_list_runs', { slug: 'gmail-new-mail', hasValue: true, limit: 5 });
const seen = new Set();
let watermark = until - 60 * 60 * 1000;
for (const [index, run] of history.runs.entries()) {
  const { value } = await call('schedule_get_run', { runId: run.runId });
  if (index === 0) {
    const stamp = Date.parse(value.until);
    watermark = Math.max(watermark, Number.isFinite(stamp) ? stamp : Date.parse(run.startedAt));
  }
  if (Array.isArray(value.newMessages)) {
    for (const message of value.newMessages) seen.add(message.messageId);
  }
}

const since = watermark - 5 * 60 * 1000;
const newMessages = [];
let truncated = false;
for (const { account, status } of accounts) {
  if (status !== 'connected') continue;
  let cursor;
  for (let page = 0; page < 10; page++) {
    const result = await call('gmail_search_emails', {
      account, query: 'after:' + Math.floor(since / 1000), limit: 25, ...(cursor ? { cursor } : {}),
    });
    let reachedOlder = false;
    for (const msg of result.messages) {
      const date = Date.parse(msg.date);
      if (date <= since) reachedOlder = true;
      if (!(date > since && date <= until) || seen.has(msg.messageId)) continue;
      newMessages.push({
        messageId: msg.messageId, date: msg.date, from: msg.from ?? '', subject: msg.subject ?? '',
        account, labels: msg.labelIds, snippet: (msg.snippet ?? '')
          .replace(/[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').replace(/\s+/g, ' ').trim(),
      });
    }
    cursor = result.nextCursor;
    if (reachedOlder || !cursor) break;
    if (page === 9) truncated = true;
  }
}
if (!newMessages.length) return null;
newMessages.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
return {
  since: new Date(since).toISOString(), until: new Date(until).toISOString(),
  count: newMessages.length, ...(truncated ? { truncated } : {}), newMessages,
};
`.trim();
