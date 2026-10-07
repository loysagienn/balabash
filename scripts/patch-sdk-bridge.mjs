// Patch of the alpha `/bridge` export of @anthropic-ai/claude-agent-sdk:
// forward `onGetContextUsage` through attachBridgeSession.
//
// Why: claude.ai / the Claude Code client of a remote-control session asks
// the worker for the context-window occupancy with a `get_context_usage`
// control request. The bridge's internal control dispatcher supports an
// `onGetContextUsage` callback, but `attachBridgeSession` (the public entry)
// does not forward it from its options — verified in 0.3.280 and 0.3.283 —
// so every such request is answered "not supported" and the client shows no
// context status. There is no public hook for control requests, hence this
// one-token insertion into the dispatcher call.
//
// How: exact anchors, each required to match exactly once; the inserted text
// reuses the minified identifiers captured from the anchors. Idempotent —
// an already patched file is left alone. Any anchor mismatch (a new SDK
// build renamed or restructured the code) fails loudly: the build stops and
// this script has to be revisited instead of the feature silently vanishing.
//
// Runs on `postinstall` and at the start of every `npm run build` (the file
// on disk is read only when the app starts, so patching never touches the
// running process).

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '[patch-sdk-bridge]';

const bridgePath = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk/bridge'));
const pkg = JSON.parse(await readFile(path.join(path.dirname(bridgePath), 'package.json'), 'utf8'));
const label = `${pkg.name}@${pkg.version} (${path.relative(process.cwd(), bridgePath)})`;

const source = await readFile(bridgePath, 'utf8');

const fail = message => {
  console.error(`${TAG} ${label}: ${message}`);
  console.error(`${TAG} the bridge changed shape — re-verify the anchors in scripts/patch-sdk-bridge.mjs`);
  process.exit(1);
};

const exactlyOne = (regex, what) => {
  const matches = [...source.matchAll(regex)];

  if (matches.length !== 1) {
    fail(`expected exactly one ${what}, found ${matches.length}`);
  }

  return matches[0];
};

// Already patched: the dispatcher call carries the forwarded callback.
if (/onSideQuestion:\w+,onGetContextUsage:\w+\.onGetContextUsage,writeFrame:/.test(source)) {
  console.log(`${TAG} ${label}: already patched`);
  process.exit(0);
}

// 1. The options destructure of attachBridgeSession — names the callback
//    variables and the options parameter.
const outer = exactlyOne(
  /onRenameSession:(\w+),onSideQuestion:(\w+),onClose:(\w+)\}=(\w+),/g,
  'attachBridgeSession options destructure',
);
const [, renameVar, sideVar, , optionsVar] = outer;

// 2. The dispatcher call inside attachBridgeSession — where the callbacks
//    are handed to the control-request dispatcher.
const call = exactlyOne(/onRenameSession:(\w+),onSideQuestion:(\w+),writeFrame:/g, 'dispatcher call site');

if (call[1] !== renameVar || call[2] !== sideVar) {
  fail(`dispatcher call site names (${call[1]}, ${call[2]}) differ from the destructure (${renameVar}, ${sideVar})`);
}

// 3. The dispatcher itself must know the callback (it reads it from its
//    options under this exact key).
exactlyOne(/onGetWorkspaceDiff:\w+,onGetContextUsage:\w+,/g, 'dispatcher onGetContextUsage option');

const patched =
  source.slice(0, call.index) +
  `onRenameSession:${renameVar},onSideQuestion:${sideVar},onGetContextUsage:${optionsVar}.onGetContextUsage,writeFrame:` +
  source.slice(call.index + call[0].length);

await writeFile(bridgePath, patched);
console.log(`${TAG} ${label}: patched — onGetContextUsage is now forwarded by attachBridgeSession`);
