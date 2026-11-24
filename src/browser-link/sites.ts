// The sites a user keeps away from the agent: the blocked list of the
// extension's settings. An entry is a domain and covers its subdomains.
// Shared by the extension, which holds the list and applies it, and by the
// tests — nothing here touches node, chrome or the DOM.
//
// The list keeps a domain the way the user wrote it — a name in Cyrillic
// stays in Cyrillic — while an address names its host in ASCII (punycode):
// the two are compared in the ASCII form of both.
//
// Besides the list there are the pages no session ever gets, whatever the
// user's settings: the pages of extensions (isExtensionPage).

// What a user typed as a site, as the list keeps it: the host in lower
// case, without a scheme, a path, a port or the leading `www.` and `*.`.
// Null when it names no host.
export function normalizeSite(input: string): string | null {
  const text = input.trim().toLowerCase();

  if (!text) {
    return null;
  }

  const withoutScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const host = withoutScheme
    .split(/[/?#]/)[0]
    .replace(/^.*@/, '')
    .replace(/:\d+$/, '')
    .replace(/^(\*\.)+/, '')
    .replace(/^www\./, '')
    .replace(/\.+$/, '');

  return /^[a-z0-9¡-￿-]+(\.[a-z0-9¡-￿-]+)*$/.test(host) ? host : null;
}

// The host as an address names it: ASCII, an international name in punycode.
function asciiHost(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host;
  }
}

// The list as it is stored: normalized, without repeats — a name and its
// punycode are one site — in the order given.
export function normalizeSites(inputs: string[]): string[] {
  const sites: string[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const site = normalizeSite(input);

    if (site && !seen.has(asciiHost(site))) {
      seen.add(asciiHost(site));
      sites.push(site);
    }
  }

  return sites;
}

// True when the address is of a blocked site: its host is an entry of the
// list or a subdomain of one. An address without a host (about:blank, a
// data: page) is of no site.
export function isBlockedUrl(url: string | undefined, sites: readonly string[]): boolean {
  if (!url || sites.length === 0) {
    return false;
  }

  let host: string;

  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return false;
  }

  return (
    host !== '' &&
    sites.some(entry => {
      const site = asciiHost(entry);

      return host === site || host.endsWith(`.${site}`);
    })
  );
}

// True for a page of an extension. Such a page has the rights of its
// extension — and Chrome lets an extension debug its own pages, the ones
// the user keeps their boundaries on.
export function isExtensionPage(url: string | undefined): boolean {
  return /^\s*chrome-extension:/i.test(url ?? '');
}
