// Where apps live, by deployment — the one place that knows both layouts:
//
// - with APPS_DOMAIN (the execution domain of the design): owner pages at
//   https://<DOMAIN>/apps/<path> (handed off to the apps domain and its
//   cookie), published apps at https://<APPS_DOMAIN>/<slug>;
// - without it (a single-host deployment):
//   everything on the main domain — owner pages at /apps/<path> behind the
//   web session, published apps at /a/<slug> without login.
//
// Apps themselves never see the difference: the shell hands them appBase.

import { config } from '../config/index.ts';

// The public prefix on the main domain. Reserved by construction: Next has
// no /a page and the main-domain apps middleware claims it before the
// session-gated surfaces.
export const PUBLIC_PATH_PREFIX = '/a';

/** Absolute base of public app URLs, no trailing slash. */
export function publicAppsBase(): string {
  return config.appsDomain ? `https://${config.appsDomain}` : `https://${config.domain}${PUBLIC_PATH_PREFIX}`;
}

export function publicAppUrl(slug: string): string {
  return `${publicAppsBase()}/${encodeURIComponent(slug)}`;
}

export function ownerAppUrl(appPath: string): string {
  return `https://${config.domain}/apps/${appPath.split('/').map(encodeURIComponent).join('/')}`;
}
