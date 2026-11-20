// A request to an API of Google on the access of an account: what the nodes
// of the Google services stand on. The node says which API it talks to and
// what its capabilities are; here is the rest — how the account's access
// goes out, what a refused token means, and who fixes a failed request.
//
// The access is the platform's to give (accountAuthority): a token good
// now. Google has the last word on it, so a request it refuses with 401 is
// made once more on a renewed token; an account that cannot be renewed
// answers auth_required from the platform, before anything is sent.

import { CapabilityError, accountAuthority, type CallContext, type JsonObject, type OAuthSettings } from '../catalog/index.ts';

export const GOOGLE_AUTHORIZATION_SERVER = 'https://accounts.google.com';

// How an account of a Google service is authorized: the client of the
// installation is registered by the operator, and the consent asks for
// offline access — Google issues a refresh token only for it, and reliably
// only on a flow that prompts for consent; without one the account dies
// with its first access token.
export function googleOAuth(
  authorizationServer: string,
  scopes: string[],
  identityProbe: NonNullable<OAuthSettings['identityProbe']>,
): OAuthSettings {
  return {
    url: authorizationServer,
    clientRegistration: 'manual',
    scope: scopes.join(' '),
    authorizationParams: { access_type: 'offline', prompt: 'consent' },
    identityProbe,
  };
}

export type GoogleApi = {
  // How the service is called in the text of an error: "Gmail".
  title: string;
  // What a 403 most likely means for this API: the API is not enabled, a
  // scope was not granted.
  forbiddenHint: string;
};

export type GoogleRequest = {
  method?: string;
  // A JSON body — or a raw one with its content type. A body is sent again
  // when the token is renewed, so it is bytes in hand, never a stream.
  json?: unknown;
  body?: Buffer | string;
  contentType?: string;
  headers?: Record<string, string>;
  accept?: string;
  // The longest the API may take to answer this request.
  timeoutMs?: number;
};

// The longest an API may take to answer one request, unless the request
// says otherwise.
const REQUEST_TIMEOUT_MS = 60_000;

// The API answered with a refusal: its status and its own words. What a
// refusal means — a missing object, a malformed argument — is the
// capability's to say: it knows what it asked for. Left as it is, the
// outside system refused.
export class GoogleRefusal extends CapabilityError {
  status: number;
  // What Google said, without what this side adds around it.
  said: string;

  constructor(message: string, status: number, said: string) {
    super('external_error', message, { status });
    this.status = status;
    this.said = said;
  }
}

function reason(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';

  return error instanceof Error ? `${error.message}${cause}` : String(error);
}

// Google's own diagnostics of a refused request, out of its error body: a
// bare status has no way to say which of a dozen reasons it stands for.
function diagnostics(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } | string; error_description?: string };

    if (parsed?.error && typeof parsed.error === 'object' && parsed.error.message) {
      return `${parsed.error.status ? `${parsed.error.status}: ` : ''}${parsed.error.message}`;
    }

    if (typeof parsed?.error === 'string') {
      return parsed.error_description ? `${parsed.error}: ${parsed.error_description}` : parsed.error;
    }
  } catch {
    // Not JSON: the body as it is.
  }

  return text.slice(0, 1_000).trim() || '(no message)';
}

export type GoogleClient = {
  // The answer of the API to a request, checked: anything but 2xx is thrown.
  // The caller reads the body as it needs.
  request(url: string, init?: GoogleRequest): Promise<Response>;
  // A request the API answers with a JSON object; {} for an empty body.
  json(url: string, init?: GoogleRequest): Promise<JsonObject>;
};

// The API as one call sees it: every request of the call goes out on the
// same access, and a token Google refused is renewed once for all of them —
// the requests of a call that run side by side do not each ask for a new
// one.
export function googleClient(api: GoogleApi, ctx: CallContext): GoogleClient {
  const authority = accountAuthority(ctx);
  const account = ctx.account ? `"${ctx.account.account}"` : 'the call acts as';
  let held: Promise<string> | null = null;
  const renewals = new Map<string, Promise<string>>();

  const token = () => (held ??= authority.accessToken());

  // A newer token than the refused one: the renewal of that very token is
  // one, whoever asks.
  function renewed(rejected: string): Promise<string> {
    let renewal = renewals.get(rejected);

    if (!renewal) {
      renewal = authority.accessToken(rejected);
      renewals.set(rejected, renewal);
      held = renewal;
    }

    return renewal;
  }

  async function send(url: string, init: GoogleRequest, accessToken: string): Promise<Response> {
    const method = init.method ?? 'GET';
    const timeoutMs = init.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const time = AbortSignal.timeout(timeoutMs);

    try {
      return await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: init.accept ?? 'application/json',
          ...(init.json !== undefined
            ? { 'content-type': 'application/json' }
            : init.contentType
              ? { 'content-type': init.contentType }
              : {}),
          ...(init.headers ?? {}),
        },
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
        signal: ctx.signal ? AbortSignal.any([ctx.signal, time]) : time,
      });
    } catch (error) {
      // No answer: whether a write took effect is not known.
      throw new CapabilityError(
        'unavailable',
        ctx.signal?.aborted
          ? `The call to ${api.title} was cancelled before it answered.`
          : time.aborted
            ? `${api.title} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`
            : `${api.title} did not answer: ${reason(error)}`,
      );
    }
  }

  async function request(url: string, init: GoogleRequest = {}): Promise<Response> {
    const first = await token();
    let response = await send(url, init, first);

    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      response = await send(url, init, await renewed(first));
    }

    if (response.ok) {
      return response;
    }

    const said = diagnostics(await response.text().catch(() => ''));
    const where = `${init.method ?? 'GET'} ${new URL(url).pathname}`;

    // A token renewed a moment ago and refused all the same: nothing this
    // side can do brings the access back.
    if (response.status === 401) {
      throw new CapabilityError(
        'auth_required',
        `${api.title} refuses the access of the account ${account}, a renewed token included (${said}): the user has to authorize the account again.`,
      );
    }

    throw new GoogleRefusal(
      `${api.title} refused the request (HTTP ${response.status} on ${where}): ${said}${response.status === 403 ? ` ${api.forbiddenHint}` : ''}`,
      response.status,
      said,
    );
  }

  return {
    request,
    async json(url, init) {
      const response = await request(url, init);
      let text: string;

      try {
        text = await response.text();
      } catch (error) {
        throw new CapabilityError('unavailable', `${api.title} broke off its answer: ${reason(error)}`);
      }

      if (!text) {
        return {};
      }

      try {
        const parsed: unknown = JSON.parse(text);

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as JsonObject;
        }
      } catch {
        // Told below.
      }

      throw new CapabilityError('external_error', `${api.title} answered with something that is not a JSON object.`);
    },
  };
}

// The outcome of a request, with a refusal that means "there is no such
// object" told as not_found in the capability's own words.
export async function orAbsent<T>(
  outcome: Promise<T>,
  message: string,
  absent: (refusal: GoogleRefusal) => boolean = refusal => refusal.status === 404,
): Promise<T> {
  try {
    return await outcome;
  } catch (error) {
    if (error instanceof GoogleRefusal && absent(error)) {
      throw new CapabilityError('not_found', message);
    }

    throw error;
  }
}
