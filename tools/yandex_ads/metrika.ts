// Yandex Metrika dialect: REST GET with `Authorization: OAuth <token>` (NOT
// Bearer — Metrika's own convention). Two APIs behind one helper: Management
// (counters, goals, segments — settings) and Stats (/stat/v1/data — the
// numbers). Eyes only: the capability deliberately performs no Metrika writes.

const METRIKA_API_BASE = 'https://api-metrika.yandex.net';

export class MetrikaApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function errorHint(status: number): string {
  switch (status) {
    case 401:
      return ' The token was rejected — ask the user to re-authorize this account via request_authorization.';
    case 403:
      return ' No access: this Yandex login does not see the counter (needs at least guest view access), or the authorization lacks the metrika:read scope.';
    case 400:
      return ' The query is malformed — check metric/dimension names and filter syntax via yandex_ads_describe("metrika").';
    case 429:
      return ' Metrika request quota exceeded — retry later.';
    default:
      return '';
  }
}

export async function metrikaGet(
  accessToken: string,
  path: string,
  query?: Record<string, string | number | undefined | null>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${METRIKA_API_BASE}${path}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: { authorization: `OAuth ${accessToken}`, accept: 'application/json' },
  });
  const text = await response.text();

  if (!response.ok) {
    let detail = text.slice(0, 800);

    try {
      const parsed = JSON.parse(text) as { message?: string; errors?: Array<{ error_type?: string; message?: string }> };
      const messages = [
        parsed.message,
        ...(parsed.errors ?? []).map(error => [error.error_type, error.message].filter(Boolean).join(': ')),
      ].filter(Boolean);

      if (messages.length) {
        detail = [...new Set(messages)].join('; ');
      }
    } catch {
      // keep raw body
    }

    throw new MetrikaApiError(`Metrika API ${response.status} on ${path}: ${detail}${errorHint(response.status)}`, response.status);
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new MetrikaApiError(`Metrika API answered non-JSON on ${path}: ${text.slice(0, 300)}`, response.status);
  }
}
