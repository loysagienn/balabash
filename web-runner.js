#!/usr/bin/env node
// The web runner: keeps the Next.js process (src/web) alive next to the core,
// in the spirit of supervisor.js — deliberately thin and dependency-free.
//
// - watches src/web sources; ~10s of quiet after the last change → next build;
// - the server restarts ONLY after a successful build — a failed build logs
//   and leaves the old server running;
// - a crashed server relaunches with backoff;
// - on boot: if a previous build exists the server starts immediately, then
//   one build catches whatever changed while the runner was down.
//
// Spawned by supervisor.js as an independent aide; can also be run by hand:
//   node --env-file=.env web-runner.js

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(ROOT, 'src', 'web');
const NEXT_BIN = path.join(WEB_DIR, 'node_modules', '.bin', 'next');
const PORT = process.env.WEB_HTTP_PORT || '3041';

const QUIET_WINDOW_MS = 10_000;
const HEALTHY_AFTER_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

// Build artifacts and installs must not retrigger builds.
const IGNORED_ROOTS = new Set(['.next', '.next-build', 'node_modules', '.swc']);
const IGNORED_FILES = new Set(['next-env.d.ts']);

let server = null;
let serverBackoffMs = 1000;
let restartAfterExit = false;
let building = false;
let pendingBuild = false;
let quietTimer = null;
let stopping = false;

function log(message) {
  console.log(`[web-runner] ${message}`);
}

function hasBuild() {
  return fs.existsSync(path.join(WEB_DIR, '.next', 'BUILD_ID'));
}

function startServer() {
  if (stopping || server || !hasBuild()) {
    return;
  }

  const startedAt = Date.now();

  server = spawn(NEXT_BIN, ['start', '-p', PORT], { cwd: WEB_DIR, stdio: 'inherit', env: process.env });
  log(`web server starting on port ${PORT}`);

  server.on('exit', (code, signal) => {
    server = null;

    if (stopping) {
      return;
    }

    if (restartAfterExit) {
      restartAfterExit = false;
      startServer();

      return;
    }

    const livedMs = Date.now() - startedAt;

    serverBackoffMs = livedMs > HEALTHY_AFTER_MS ? 1000 : Math.min(MAX_BACKOFF_MS, serverBackoffMs * 2);
    log(`web server died (code=${code}, signal=${signal}) after ${Math.round(livedMs / 1000)}s; relaunch in ${serverBackoffMs}ms`);
    setTimeout(startServer, serverBackoffMs);
  });
}

function restartServer() {
  if (!server) {
    startServer();

    return;
  }

  restartAfterExit = true;
  server.kill('SIGTERM');
}

function runBuild() {
  if (stopping) {
    return;
  }

  if (building) {
    pendingBuild = true;

    return;
  }

  building = true;
  log('next build…');

  // Build into .next-build and swap on success: the .next the running server
  // reads is never touched by an in-flight or failed build.
  const build = spawn(NEXT_BIN, ['build'], {
    cwd: WEB_DIR,
    stdio: 'inherit',
    env: { ...process.env, NEXT_DIST_DIR: '.next-build' },
  });

  build.on('exit', code => {
    building = false;

    if (code === 0) {
      try {
        fs.rmSync(path.join(WEB_DIR, '.next'), { recursive: true, force: true });
        fs.renameSync(path.join(WEB_DIR, '.next-build'), path.join(WEB_DIR, '.next'));
        log('build succeeded — restarting the web server');
        restartServer();
      } catch (error) {
        console.error('[web-runner] failed to swap the built bundle in:', error);
      }
    } else {
      log(`build FAILED (code=${code}) — the old server keeps running`);
    }

    if (pendingBuild) {
      pendingBuild = false;
      runBuild();
    }
  });
}

function isIgnored(filename) {
  if (!filename) {
    return false;
  }

  const [first] = filename.split(path.sep);

  return IGNORED_ROOTS.has(first) || IGNORED_FILES.has(filename);
}

if (!fs.existsSync(NEXT_BIN)) {
  console.error('[web-runner] src/web/node_modules/.bin/next is missing — run: cd src/web && npm install --include=dev');
  process.exit(1);
}

fs.watch(WEB_DIR, { recursive: true }, (eventType, filename) => {
  if (isIgnored(filename ?? '')) {
    return;
  }

  clearTimeout(quietTimer);
  quietTimer = setTimeout(runBuild, QUIET_WINDOW_MS);
});

// The client also bundles pieces of the core tree: src/utils (isolated
// runtime modules) and src/api (contract types). Changes there must retrigger
// the web build too.
for (const shared of ['src/utils', 'src/api'].map(dir => path.join(ROOT, dir))) {
  if (!fs.existsSync(shared)) {
    continue;
  }

  fs.watch(shared, { recursive: true }, () => {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(runBuild, QUIET_WINDOW_MS);
  });
}

// Old build → serve it right away; the boot build below picks up anything
// that changed while the runner was down.
startServer();
runBuild();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    clearTimeout(quietTimer);

    if (server) {
      server.kill(signal);
      // Give next start a moment to shut down, then follow.
      setTimeout(() => process.exit(0), 5_000).unref();
      server.on('exit', () => process.exit(0));
    } else {
      process.exit(0);
    }
  });
}
