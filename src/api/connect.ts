// Browser-facing endpoints of the per-user OAuth flow (§10, §11.4):
// - /connect/<server>?nonce=… — entry from the one-time link issued by the
//   auth agent; redirects to the provider's consent page;
// - /oauth/callback — the single registered OAuth redirect URI for every
//   provider; exchanges the code and shows a plain closing page.
//
// Mounted before any session machinery: these hits come from one-time links,
// redirect chains and link previews — the nonce and the OAuth state are the
// credentials BY NATURE of the flow. The secret forms that used to live here
// moved behind the session: /secrets/<requestId> (Next page) over
// /api/secret-requests.

import type { Context, Next } from 'koa';
import { handleConnectClick, handleOauthCallback } from '../capabilities/connections/index.ts';
import { renderConnectionCompletedMessage, renderSafeErrorPage, renderStatusPage } from './pages.ts';

const CONNECT_PATH_PATTERN = /^\/connect\/([a-z][a-z0-9_]*)$/;

export const connect = async (ctx: Context, next: Next): Promise<void> => {
  const connectMatch = ctx.path.match(CONNECT_PATH_PATTERN);

  if (connectMatch && ctx.method === 'GET') {
    const nonce = typeof ctx.query.nonce === 'string' ? ctx.query.nonce : '';

    try {
      ctx.redirect(await handleConnectClick(connectMatch[1], nonce));
    } catch (error) {
      ctx.status = 400;
      ctx.type = 'html';
      ctx.body = renderSafeErrorPage('Authorization failed', error);
    }

    return;
  }

  if (ctx.path === '/oauth/callback' && ctx.method === 'GET') {
    const outcome = await handleOauthCallback(ctx.query as Record<string, unknown>);

    ctx.type = 'html';

    if (outcome.ok) {
      ctx.body = renderStatusPage('Authorization completed', renderConnectionCompletedMessage(outcome.server ?? ''));
    } else {
      ctx.status = 400;
      ctx.body = renderSafeErrorPage('Authorization failed', outcome.error ?? 'Unknown error');
    }

    return;
  }

  return next();
};
