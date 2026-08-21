// Validates a Balabash mini-app folder BEFORE opening it in the browser:
// the manifest against the platform's own zod schema (the exact one the
// runtime uses — src/apps/manifest.ts), plus existence of the entry and
// styles files. Usage:
//
//   node validate.mjs <app-folder>
//
// Exit code 0 = valid, 1 = problems (printed).

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// plugins/balabash/skills/app-builder → the repository root is four levels up.
const { appManifestSchema, APP_MANIFEST_FILENAME } = await import(
  path.join(here, '..', '..', '..', '..', 'src', 'apps', 'manifest.ts')
);

const appDir = process.argv[2];

if (!appDir) {
  console.error('Usage: node validate.mjs <app-folder>');
  process.exit(1);
}

const problems = [];
const manifestPath = path.join(appDir, APP_MANIFEST_FILENAME);

let raw;

try {
  raw = await fs.readFile(manifestPath, 'utf8');
} catch {
  console.error(`✗ ${manifestPath} does not exist — the folder is not an app`);
  process.exit(1);
}

let manifest = null;

try {
  const parsed = JSON.parse(raw);
  const result = appManifestSchema.safeParse(parsed);

  if (result.success) {
    manifest = result.data;
  } else {
    for (const issue of result.error.issues) {
      problems.push(`manifest ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  }
} catch (error) {
  problems.push(`${APP_MANIFEST_FILENAME} is not valid JSON: ${error.message}`);
}

if (manifest) {
  const files = [manifest.entry, ...manifest.styles];

  for (const file of files) {
    const stats = await fs.stat(path.join(appDir, file)).catch(() => null);

    if (!stats?.isFile()) {
      problems.push(`declared file is missing: ${file}`);
    }
  }
}

if (problems.length) {
  for (const problem of problems) {
    console.error(`✗ ${problem}`);
  }
  process.exit(1);
}

console.log(`✓ ${appDir}: the manifest is valid (${Object.keys(manifest.api).length} endpoint(s)), all declared files exist`);
console.log('Remember: create the app tables via data_query yourself — the platform executes no DDL.');
