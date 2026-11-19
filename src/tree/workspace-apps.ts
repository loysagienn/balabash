// The node `workspace_apps`: the mini-apps of the workspace. An app is its
// folder in the file area — created and edited as files; here only the
// publication changes, and the apps are listed. The rules are the apps
// platform's own (src/apps/management.ts, one implementation for the
// console and for a call); a publication made by a call is authored by the
// calling thread.

import { z } from 'zod';
import { CapabilityError, WorkspacePath, capability, node, type Caller, type ErrorKind } from '../catalog/index.ts';
import { AppManagementError, listApps, publishApp, unpublishApp, type AppManagementErrorCode } from '../apps/management.ts';
import { publicAppUrl } from '../apps/urls.ts';
import type { RegistryAuthor } from '../core/registry-events.ts';
import { areaPath } from './file-area.ts';

function author(caller: Caller): RegistryAuthor {
  return { kind: 'thread', workspaceId: caller.workspaceId, threadId: caller.threadId };
}

const REFUSALS: Record<AppManagementErrorCode, ErrorKind> = {
  bad_request: 'invalid_input',
  not_found: 'not_found',
  conflict: 'conflict',
};

// A refusal of the apps platform in the kinds of the catalog; anything else
// is a defect and stays what it is.
async function management<T>(change: () => Promise<T>): Promise<T> {
  try {
    return await change();
  } catch (error) {
    if (error instanceof AppManagementError) {
      throw new CapabilityError(REFUSALS[error.code], error.message);
    }

    throw error;
  }
}

const list = capability({
  name: 'list',
  summary: 'List the mini-apps of the workspace with their publication state',
  description: 'List the mini-apps of the workspace: every folder of the file area with a balabash-app.json manifest.',
  input: z.strictObject({}),
  output: z.strictObject({
    apps: z.array(
      z.strictObject({
        path: WorkspacePath.describe('The app folder.'),
        name: z.string().nullable().describe('From the manifest; null when it does not parse.'),
        description: z.string().nullable(),
        manifestError: z.string().nullable().describe('null when the manifest is valid.'),
        slug: z.string().nullable().describe('Public slug; null when the app is not published.'),
        ownerUrl: z.string().describe('Where the owner opens the app; authorization required.'),
        publicUrl: z.string().nullable(),
      }),
    ),
  }),
  async run(_input, { caller }) {
    const apps = await listApps(caller.workspaceId);

    return {
      apps: apps.map(app => ({
        path: app.path,
        name: app.name,
        description: app.description,
        manifestError: app.manifestError,
        slug: app.slug,
        ownerUrl: app.ownerUrl,
        publicUrl: app.slug === null ? null : publicAppUrl(app.slug),
      })),
    };
  },
});

const publish = capability({
  name: 'publish',
  summary: 'Publish a mini-app under a public slug',
  description:
    'Publish a mini-app: anyone can open it without authorization at the public address under the slug. The folder must be a valid app.',
  input: z.strictObject({
    path: WorkspacePath.describe('The app folder.'),
    slug: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
      .describe('Globally unique; "apps", "auth" and "platform" are reserved.'),
  }),
  output: z.strictObject({ publicUrl: z.string() }),
  async run(input, { caller }) {
    const appPath = areaPath(input.path);
    const { slug } = await management(() => publishApp(caller.workspaceId, appPath, input.slug, author(caller)));

    return { publicUrl: publicAppUrl(slug) };
  },
});

const unpublish = capability({
  name: 'unpublish',
  summary: 'Remove the publication of a mini-app',
  description:
    'Remove the publication of a mini-app: its public address stops answering. The folder and the app are untouched.',
  input: z.strictObject({
    path: WorkspacePath.describe('The app folder.').optional(),
    slug: z.string().describe('The public slug; it decides when both are given.').optional(),
  }),
  inputRules: [{ atLeastOne: ['path', 'slug'] }],
  output: z.strictObject({
    path: WorkspacePath,
    slug: z.string(),
  }),
  async run(input, { caller }) {
    const appPath = input.path === undefined ? undefined : areaPath(input.path);

    // A slug that is given is the address: a blank one names nothing.
    if (input.slug !== undefined && !input.slug.trim()) {
      throw new CapabilityError('invalid_input', 'slug is blank: pass a value or leave the field out.');
    }

    const { path, slug } = await management(() => unpublishApp(caller.workspaceId, appPath, input.slug, author(caller)));

    return { path, slug };
  },
});

export const workspaceApps = node({
  name: 'apps',
  summary:
    'Mini-apps of the workspace: folders of the file area with a balabash-app.json manifest, run by the platform in the browser. Come here to list apps and to publish or unpublish one.',
  guide: [
    { text: 'An app is its folder: it is created and edited as files, not here.' },
    {
      text: 'A published app is open to anyone without authorization. Pick a readable slug, or an unguessable one when the link must stay private.',
    },
    {
      text: 'To change the slug of a published app, unpublish it and publish again. Deleting the app folder removes the public address too.',
    },
  ],
  children: [list, publish, unpublish],
});
