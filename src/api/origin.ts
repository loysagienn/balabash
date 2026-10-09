// The cross-site guard of the session-gated mutations. The session is a
// cookie, so a page on another site could make the browser POST here with
// it; the browser tells us where a request came from, and a mutation is
// accepted only from the API's own origin. Fetch metadata first
// (Sec-Fetch-Site: every current browser sends it, and it cannot be forged
// by a page), the Origin header as the fallback for older browsers; a
// request with neither is not a browser's (curl, a script holding the
// cookie on purpose) and passes. Reads are never gated: they carry nothing
// a cross-site page could read back (CORS) and change nothing.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type OriginCheckInput = {
  method: string;
  // The host the request was addressed to (Koa's ctx.host: Host or
  // X-Forwarded-Host behind the proxy, with the port when there is one).
  host: string;
  secFetchSite?: string | undefined;
  origin?: string | undefined;
};

// 'ok' — serve; 'cross-site' — refuse (403).
export function checkMutationOrigin({ method, host, secFetchSite, origin }: OriginCheckInput): 'ok' | 'cross-site' {
  if (SAFE_METHODS.has(method.toUpperCase())) {
    return 'ok';
  }

  if (secFetchSite !== undefined) {
    // same-origin — the page of this host; none — the user's own action
    // (typing the URL, a bookmark). same-site and cross-site are other
    // origins, including sibling subdomains with their own pages.
    return secFetchSite === 'same-origin' || secFetchSite === 'none' ? 'ok' : 'cross-site';
  }

  if (origin !== undefined) {
    return originHost(origin) === host.toLowerCase() ? 'ok' : 'cross-site';
  }

  return 'ok';
}

// The host[:port] of an Origin header value; null for "null" and garbage.
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase() || null;
  } catch {
    return null;
  }
}
