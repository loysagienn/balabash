// The user's cookies in what the debugger says about the network. A session
// may not read cookies through the debugger (the extension refuses the
// commands that do), yet the network messages of CDP carry them all the
// same: the `Cookie` and `Set-Cookie` headers of every request and response
// of a tab — the cookies its own JavaScript cannot see among them — and the
// cookie objects that say which ones went with a request. The extension
// takes the values out before a message leaves the browser: the names stay,
// so that a client still sees which cookies there were.
//
// Shared by the extension and by the tests — nothing here touches node,
// chrome or the DOM.

// The domains whose messages speak of requests and responses.
const NETWORK_METHOD = /^(Network|Fetch)\./;
const COOKIE_HEADER = /^(set-)?cookie2?$/i;
const COOKIE_HEADER_LINE = /^(set-)?cookie2?\s*:.*(\r?\n|$)/gim;
// Lists of cookies, or of a cookie with what became of it.
const COOKIE_LISTS = new Set(['cookies', 'associatedCookies', 'blockedCookies', 'exemptedCookies']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// A cookie, or an entry that holds one, without its value.
function blank(entry: unknown): unknown {
  if (!isRecord(entry)) {
    return entry;
  }

  return {
    ...entry,
    ...(typeof entry.value === 'string' ? { value: '' } : {}),
    ...(typeof entry.cookieLine === 'string' ? { cookieLine: '' } : {}),
    ...(isRecord(entry.cookie) ? { cookie: blank(entry.cookie) } : {}),
  };
}

function scrub(value: unknown, key: string): unknown {
  const headers = /headers$/i.test(key);

  if (typeof value === 'string') {
    return /headersText$/i.test(key) ? value.replace(COOKIE_HEADER_LINE, '') : value;
  }

  if (Array.isArray(value)) {
    if (COOKIE_LISTS.has(key)) {
      return value.map(blank);
    }

    // Headers as a list of `{ name, value }`.
    const kept = headers ? value.filter(entry => !(isRecord(entry) && typeof entry.name === 'string' && COOKIE_HEADER.test(entry.name))) : value;

    return kept.map(entry => scrub(entry, ''));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !(headers && COOKIE_HEADER.test(name)))
        .map(([name, inner]) => [name, scrub(inner, name)]),
    );
  }

  return value;
}

// The params of an event of the debugger, or the result of a command, as a
// session gets them: without the values of cookies. Anything that is not of
// the network passes as it is.
export function withoutCookies<T>(method: string, payload: T): T {
  return NETWORK_METHOD.test(method) ? (scrub(payload, '') as T) : payload;
}
