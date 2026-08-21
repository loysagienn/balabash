// The passport of an app: balabash-app.json is the single marker that turns
// a workspace folder into an app, and the manifest is the whole declaration
// the platform executes — entry/styles for the UI and the api section as the
// app's entire server-side perimeter (design.md §3). Tables are NOT declared
// here (decision №13): the authoring agent creates them via data_query; the
// platform never executes anything beyond the declared statements, DDL
// included.

import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { workspaceFilesDir } from '../workspace/layout.ts';

export const APP_MANIFEST_FILENAME = 'balabash-app.json';

// Param types: string | number | boolean, '?' marks an optional param.
const paramTypeSchema = z.enum(['string', 'number', 'boolean', 'string?', 'number?', 'boolean?']);

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an identifier');

const endpointSchema = z.strictObject({
  params: z.record(identifier, paramTypeSchema).default({}),
  statement: z.string().min(1),
  kind: z.enum(['run', 'all', 'get']),
});

// A source-relative path inside the app folder: no leading slash, no "..".
// The serve path re-checks through sanitizeRelPath; this is the authoring-
// time shape so a broken manifest fails loudly at validation.
const appRelPath = z
  .string()
  .min(1)
  .max(300)
  .refine(value => !value.startsWith('/') && !value.split('/').some(s => !s || s === '.' || s === '..'), {
    message: 'must be a relative path inside the app folder without "." or ".." segments',
  });

export const appManifestSchema = z.strictObject({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  entry: appRelPath.refine(value => /\.(tsx|ts|jsx|js)$/.test(value), {
    message: 'entry must be a .tsx/.ts/.jsx/.js module',
  }),
  styles: z
    .array(appRelPath.refine(value => value.endsWith('.css'), { message: 'styles must be .css files' }))
    .default([]),
  api: z.record(identifier, endpointSchema).default({}),
});

export type AppManifest = z.infer<typeof appManifestSchema>;
export type AppEndpoint = AppManifest['api'][string];

export type ManifestResult =
  | { status: 'ok'; manifest: AppManifest }
  | { status: 'invalid'; error: string }
  | { status: 'absent' };

/**
 * Reads and validates the manifest of the app folder at appRelPath (relative
 * to the user's file area, already sanitized by the caller). 'absent' means
 * the folder is not an app at all; 'invalid' is an app with a broken
 * passport — the edge renders it as a readable error page, never a 500.
 */
export async function readAppManifest(userId: string, appRelPath2: string): Promise<ManifestResult> {
  const absPath = path.join(workspaceFilesDir(userId), appRelPath2, APP_MANIFEST_FILENAME);

  let raw: string;

  try {
    raw = await fs.readFile(absPath, 'utf8');
  } catch {
    return { status: 'absent' };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: 'invalid', error: `${APP_MANIFEST_FILENAME} is not valid JSON: ${(error as Error).message}` };
  }

  const result = appManifestSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');

    return { status: 'invalid', error: `${APP_MANIFEST_FILENAME} failed validation — ${issues}` };
  }

  return { status: 'ok', manifest: result.data };
}
