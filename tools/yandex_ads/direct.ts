// Yandex Direct v5 JSON dialect: POST /json/v5/{service} with
// {"method","params"}, Authorization: Bearer, answers in {"result"} or
// {"error"}. Errors and unit quotas are normalized into "what happened and
// what to do" — the raw provider diagnostics stay verbatim inside.

const DIRECT_API_BASE = 'https://api.direct.yandex.com/json/v5';

export type DirectUnits = { spent: number; available: number; daily_limit: number } | null;

export class DirectApiError extends Error {
  code: number | null;

  constructor(message: string, code: number | null) {
    super(message);
    this.code = code;
  }
}

// Hints for the error codes an agent can actually act on.
function errorHint(code: number | null): string {
  switch (code) {
    case 52:
    case 53:
      return ' The OAuth token was rejected — ask the user to re-authorize this account via request_authorization.';
    case 54:
      return ' No rights for the operation: most often this Yandex login has not accepted the Direct API user agreement in its Direct cabinet, or the installation OAuth app has no approved Direct API access.';
    case 56:
      return ' Method request limit exceeded — retry later.';
    case 152:
      return ' Not enough API units (points) for today — retry after the daily quota resets.';
    case 1000:
    case 1001:
    case 1002:
      return ' The request is malformed — check the payload form via yandex_ads_describe.';
    case 8800:
      return ' Too many concurrent requests for this login — retry in a moment.';
    default:
      return '';
  }
}

export function parseUnitsHeader(headerValue: string | null): DirectUnits {
  if (!headerValue) {
    return null;
  }

  const [spent, available, dailyLimit] = headerValue.split('/').map(part => Number(part));

  if ([spent, available, dailyLimit].some(part => !Number.isFinite(part))) {
    return null;
  }

  return { spent, available, daily_limit: dailyLimit };
}

export async function directCall(
  accessToken: string,
  service: string,
  method: string,
  params: unknown,
): Promise<{ result: unknown; units: DirectUnits }> {
  const response = await fetch(`${DIRECT_API_BASE}/${service}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'accept-language': 'ru',
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ method, params }),
  });
  const units = parseUnitsHeader(response.headers.get('units'));
  const text = await response.text();

  let body: Record<string, unknown>;

  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new DirectApiError(
      `Direct API ${response.status} on ${service}.${method}: non-JSON answer ${text.slice(0, 500)}`,
      null,
    );
  }

  const error = body.error as
    | { error_code?: number | string; error_string?: string; error_detail?: string; request_id?: string }
    | undefined;

  if (error) {
    const code = Number(error.error_code);
    const normalizedCode = Number.isFinite(code) ? code : null;
    const detail = [error.error_string, error.error_detail].filter(Boolean).join(' — ');

    throw new DirectApiError(
      `Direct API error ${error.error_code ?? response.status} on ${service}.${method}: ${detail || 'no detail'}` +
        `${error.request_id ? ` (request_id ${error.request_id})` : ''}.${errorHint(normalizedCode)}`,
      normalizedCode,
    );
  }

  if (!response.ok) {
    throw new DirectApiError(`Direct API ${response.status} on ${service}.${method}: ${text.slice(0, 500)}`, null);
  }

  return { result: body.result ?? body, units };
}
