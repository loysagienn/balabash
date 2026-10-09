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
import { createConsoleMiddleware } from './console.ts';

const CLIENT_ABORT_CODES = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ECONNABORTED', 'EPIPE']);

export function startWebServer(): void {
  const app = new Koa();

  // Behind the TLS-terminating proxy: trust X-Forwarded-* for protocol/ip.
  app.proxy = true;

  // A client leaving mid-stream (a download or preview abandoned, a tab
  // closed) is not a server error, yet Koa's default reporter prints a
  // stack for each — enough to flush a real error out of a short log.
  // Everything else keeps Koa's own reporting.
  app.on('error', (error: NodeJS.ErrnoException) => {
    if (CLIENT_ABORT_CODES.has(error.code ?? '')) {
      return;
    }

    app.onerror(error);
  });

  // The apps execution domain first: a host-aware branch that owns the
  // whole balabash.app host and never falls through — none of the surfaces
  // below exist there (src/apps/index.ts).
  app.use(createAppsMiddleware());

  // The console host next: on CONSOLE_DOMAIN only /api and /files of the
  // surfaces below exist (they fall through), everything else is the SPA —
  // its assets and its shell (src/api/console.ts).
  app.use(createConsoleMiddleware());

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
