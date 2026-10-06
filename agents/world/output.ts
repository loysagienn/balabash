// The output channel of a thread-bound session agent: how a turn's final text
// reaches the user. Channel-neutral by design — agents do not know which
// channel (web, Telegram, Claude app, …) shows the thread; rendering the text
// for a particular channel's markup is the delivery adapter's job
// (src/adapters/*), never the prompt's.
export const OUTPUT_NOTE =
  'How your output reaches the user: the final text of each of your turns is sent into the thread as your message. ' +
  "Keep it in the user's language. Write standard Markdown. Never end a turn with empty final text.";
