import path from 'node:path';
import type { NextConfig } from 'next';

// In production nginx routes /api/ and /files/ to the core process (port
// 3040) before a request ever reaches Next; these rewrites only serve direct
// access to the Next port — dev runs and smoke tests without nginx in front.
const CORE_HTTP_PORT = process.env.HTTP_PORT || '3040';

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
      {
        source: '/api/:path*',
        destination: `http://127.0.0.1:${CORE_HTTP_PORT}/api/:path*`,
      },
      {
        source: '/files/:path*',
        destination: `http://127.0.0.1:${CORE_HTTP_PORT}/files/:path*`,
      },
    ];
  },
};

export default nextConfig;
