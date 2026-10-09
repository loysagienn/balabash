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
  // The scheme and host the request was addressed to, as Koa sees them
  // behind the trusted proxy (app.proxy): ctx.protocol from
  // X-Forwarded-Proto, ctx.host from X-Forwarded-Host or Host, with the
  // port when there is one. Together they are the request's own origin.
  protocol: string;
  host: string;
  secFetchSite?: string | undefined;
  origin?: string | undefined;
};

// 'ok' — serve; 'cross-site' — refuse (403).
export function checkMutationOrigin({ method, protocol, host, secFetchSite, origin }: OriginCheckInput): 'ok' | 'cross-site' {
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
    // The whole origin: an http page of this very host is another origin
    // on an https API (and the other way round).
    const own = canonicalOrigin(`${protocol}://${host}`);

    return own !== null && canonicalOrigin(origin) === own ? 'ok' : 'cross-site';
  }

  return 'ok';
}

// scheme://host[:port] in canonical form (lower case, a default port
// dropped); null for "null", garbage and a non-http scheme.
function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);

    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host ? url.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}
