// The web surface (§11.4). Stage 4 scope: the provisioning and OAuth
// endpoints — they must exist before the first integration connects. The
// full second adapter (sessions, thread pages, event feed) is deliberately
// later (§15).

import Koa from 'koa';
import { config } from '../config/index.ts';
import { connect } from './connect.ts';
import { createApiMiddleware } from './api.ts';

export function startWebServer(): void {
  const app = new Koa();

  // Behind the TLS-terminating proxy: trust X-Forwarded-* for protocol/ip.
  app.proxy = true;

  // Nonce/state-authenticated surfaces first (one-time links, OAuth
  // redirects), then the session-gated /api namespace.
  app.use(connect);
  app.use(createApiMiddleware());

  app.use(ctx => {
    ctx.status = 404;
    ctx.body = 'Not found';
  });

  app.listen(config.httpPort);

  console.log(`[web] listening on port ${config.httpPort}`);
}
