import path from 'node:path';
import type { NextConfig } from 'next';

// Every path of the core's Koa surface (src/api/index.ts) is rewritten to the
// core process: /api, /files, the one-time provisioning links /connect/*, the
// OAuth callback, the apps surfaces (/apps owner pages, /a public slugs,
// /platform vendor + data gateway). With nginx in front these paths never
// reach Next; on a single-port deployment (Next itself is the edge, e.g. a
// Coder workspace ingress) they are the
// routing. Next's own pages (/, /login, /thread, /workspace, /applications,
// /secrets, /llm-usage) never collide with them by construction.
const CORE_HTTP_PORT = process.env.HTTP_PORT || '3040';

const CORE_PATHS = ['/api', '/files', '/connect', '/apps', '/a', '/platform'];

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // The runner builds into a separate dir (NEXT_DIST_DIR=.next-build) and
  // swaps it in only on success: the running server's .next is never touched
  // by an in-flight or failed build. `next start` runs without the var.
  distDir: process.env.NEXT_DIST_DIR || '.next',

  // The module-graph root is the REPO root, two levels above src/web: the
  // client imports src/api/contract.ts (type-only) and src/utils/* (isolated
  // runtime modules) from the core tree. Also silences the two-lockfiles
  // root inference warning. next build always runs with cwd = src/web.
  outputFileTracingRoot: path.resolve(process.cwd(), '..', '..'),
  turbopack: { root: path.resolve(process.cwd(), '..', '..') },

  async rewrites() {
    return [
      ...CORE_PATHS.flatMap(prefix => [
        // Both the bare prefix (/apps is the owner catalog) and everything under it.
        { source: prefix, destination: `http://127.0.0.1:${CORE_HTTP_PORT}${prefix}` },
        { source: `${prefix}/:path*`, destination: `http://127.0.0.1:${CORE_HTTP_PORT}${prefix}/:path*` },
      ]),
      { source: '/oauth/callback', destination: `http://127.0.0.1:${CORE_HTTP_PORT}/oauth/callback` },
    ];
  },
};

export default nextConfig;
