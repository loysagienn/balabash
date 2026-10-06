// The web surface (§11.4). Stage 4 scope: the provisioning and OAuth
// endpoints — they must exist before the first integration connects. The
// full second adapter (sessions, thread pages, event feed) is deliberately
// later (§15).

import Koa from 'koa';
import { config } from '../config/index.ts';
import { connect } from './connect.ts';
import { createApiMiddleware, createFilesMiddleware } from './api.ts';
import { createAppsMiddleware } from '../apps/index.ts';
import { createAppsHandoffMiddleware } from '../apps/handoff.ts';
import { createMainDomainAppsMiddleware } from '../apps/index.ts';

export function startWebServer(): void {
  const app = new Koa();

  // Behind the TLS-terminating proxy: trust X-Forwarded-* for protocol/ip.
  app.proxy = true;

  // The apps execution domain first: a host-aware branch that owns the
  // whole balabash.app host and never falls through — none of the surfaces
  // below exist there (src/apps/index.ts).
  app.use(createAppsMiddleware());

  // Nonce/state-authenticated surfaces first (one-time links, OAuth
  // redirects), then the session-gated byte surface /files and the
  // session-gated /api namespace. The apps surfaces of the main domain sit
  // with the session-gated ones: with an apps domain the /apps handoff
  // turns the web session into a one-time token for that domain; without
  // one the whole apps runtime runs here (/apps owner pages by the web
  // session, /a/<slug> public, /platform/*). Each gates itself on
  // config.appsDomain.
  app.use(connect);
  app.use(createAppsHandoffMiddleware());
  app.use(createMainDomainAppsMiddleware());
  app.use(createFilesMiddleware());
  app.use(createApiMiddleware());

  app.use(ctx => {
    ctx.status = 404;
    ctx.body = 'Not found';
  });

  app.listen(config.httpPort);

  console.log(`[web] listening on port ${config.httpPort}`);
}
