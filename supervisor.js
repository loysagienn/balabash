#!/usr/bin/env node
// The supervisor: a deliberately thin restart-on-exit loop over dist/app.js.
// No dependencies, no bundling, no signalling channel — the app talks to it
// through exit codes alone:
//
//   42  — restart requested (src/runtime/restart.ts RESTART_EXIT_CODE):
//         relaunch immediately; the app already waited for its safe window.
//   0   — intentional stop: the supervisor exits too.
//   *   — crash: relaunch with backoff; after QUICK_CRASH_LIMIT consecutive
//         quick crashes roll dist/ back to the last bundle that reached a
//         healthy uptime, leaving a marker the app reports on its next boot.
//
// The supervisor itself changes rarely and only by hand — keep it boring.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const BOOTING = path.join(ROOT, 'dist-booting');
const LAST_GOOD = path.join(ROOT, 'dist-last-good');
const ROLLBACK_MARKER = path.join(ROOT, 'data', 'supervisor', 'rollback.json');

const RESTART_EXIT_CODE = 42; // keep in sync with src/runtime/restart.ts
const HEALTHY_AFTER_MS = 60_000; // alive this long → the booted bundle becomes last-good
const QUICK_CRASH_LIMIT = 3; // consecutive quick crashes → roll back
const RESTART_DELAY_MS = 300;
const MAX_BACKOFF_MS = 30_000;

let child = null;
let stopping = false;
let quickCrashes = 0;

function log(message) {
  console.log(`[supervisor] ${message}`);
}

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  // Timestamps preserved so sameBundle() can compare dist/ against last-good
  // by mtime after a rollback.
  fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
}

// The bundle being booted is snapshotted before spawn and promoted to
// last-good only once the process proves healthy — a fresh build sitting in
// dist/ while an older healthy process runs must not be blessed by it.
function snapshotBooting() {
  try {
    copyDir(DIST, BOOTING);
  } catch (error) {
    console.error('[supervisor] failed to snapshot the booting bundle:', error);
  }
}

function promoteBootingToLastGood() {
  try {
    if (!fs.existsSync(BOOTING)) {
      return;
    }

    fs.rmSync(LAST_GOOD, { recursive: true, force: true });
    fs.renameSync(BOOTING, LAST_GOOD);
    log('bundle reached healthy uptime — saved as last-good');
  } catch (error) {
    console.error('[supervisor] failed to promote last-good:', error);
  }
}

function sameBundle(a, b) {
  try {
    const statA = fs.statSync(path.join(a, 'app.js'));
    const statB = fs.statSync(path.join(b, 'app.js'));

    return statA.size === statB.size && statA.mtimeMs === statB.mtimeMs;
  } catch {
    return false;
  }
}

function rollbackToLastGood() {
  if (!fs.existsSync(LAST_GOOD) || sameBundle(DIST, LAST_GOOD)) {
    return false;
  }

  try {
    copyDir(LAST_GOOD, DIST);
    fs.mkdirSync(path.dirname(ROLLBACK_MARKER), { recursive: true });
    fs.writeFileSync(
      ROLLBACK_MARKER,
      JSON.stringify({ at: new Date().toISOString(), reason: 'crash-loop', quickCrashes }, null, 2),
    );
    log('rolled dist/ back to the last-good bundle');

    return true;
  } catch (error) {
    console.error('[supervisor] rollback failed:', error);

    return false;
  }
}

function start() {
  const startedAt = Date.now();

  snapshotBooting();

  child = spawn(process.execPath, ['--enable-source-maps', '--env-file=.env', 'dist/app.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });

  const healthyTimer = setTimeout(() => {
    quickCrashes = 0;
    promoteBootingToLastGood();
  }, HEALTHY_AFTER_MS);

  child.on('exit', (code, signal) => {
    clearTimeout(healthyTimer);
    fs.rmSync(BOOTING, { recursive: true, force: true });
    child = null;

    if (stopping) {
      process.exit(code ?? 0);
    }

    if (code === RESTART_EXIT_CODE) {
      log('restart requested by the app — relaunching');
      setTimeout(start, RESTART_DELAY_MS);

      return;
    }

    if (code === 0) {
      log('app exited cleanly — supervisor exits');
      process.exit(0);
    }

    const livedMs = Date.now() - startedAt;

    quickCrashes = livedMs < HEALTHY_AFTER_MS ? quickCrashes + 1 : 1;
    log(`app died (code=${code}, signal=${signal}) after ${Math.round(livedMs / 1000)}s; quick crashes in a row: ${quickCrashes}`);

    if (quickCrashes >= QUICK_CRASH_LIMIT && rollbackToLastGood()) {
      quickCrashes = 0;
    }

    const backoffMs = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(quickCrashes, 5));

    setTimeout(start, backoffMs);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;

    if (child) {
      child.kill(signal);
    } else {
      process.exit(0);
    }
  });
}

log('starting dist/app.js');
start();
