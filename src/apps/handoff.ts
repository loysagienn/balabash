// The main-domain side of the owner handoff (step 3 of the /apps plan).
// nginx already routes /apps/* of the main domain into the core (like /api
// and /files); the core draws NOTHING here (design №6) — it only turns a
// valid web session into a one-time token and bounces the browser to the
// apps domain:
//
//   /apps/foo → 302 https://<appsDomain>/auth?token=…&redirect=/apps/foo
//
// No session → the usual main-domain login flow (/login?next=…, served by
// Next). This is also the landing pad of the self-refresh loop: an expired
// apps cookie sends the browser back here with the same path.

import type { Context, Next } from 'koa';
import { config } from '../config/index.ts';
import { getSession } from '../api/session.ts';
import { mintHandoffToken, sanitizeAppsRedirect } from './auth.ts';

export function createAppsHandoffMiddleware(): (ctx: Context, next: Next) => Promise<void> {
  return async (ctx, next) => {
    if (ctx.path !== '/apps' && !ctx.path.startsWith('/apps/')) {
      await next();

      return;
    }

    // Without an apps domain the whole surface does not exist: fall through
    // to the ordinary 404 of the main domain.
    const appsDomain = config.appsDomain;

    if (!appsDomain) {
      await next();

      return;
    }

    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
      ctx.status = 405;
      ctx.body = 'Method not allowed';

      return;
    }

    // The destination is the request's own path (+query), re-validated as a
    // local /apps path — the same value later crosses /auth?redirect=… .
    const target = sanitizeAppsRedirect(ctx.path + ctx.search);

    const session = await getSession(ctx);

    if (!session || !session.userId) {
      ctx.redirect(`/login?next=${encodeURIComponent(target)}`);

      return;
    }

    const token = mintHandoffToken(session.userId);

    ctx.status = 302;
    ctx.redirect(`https://${appsDomain}/auth?token=${encodeURIComponent(token)}&redirect=${encodeURIComponent(target)}`);
  };
}
