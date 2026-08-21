// Apps platform management tools (step 5 of the /apps plan): the
// secretary's window into publications — list the workspace's apps, publish
// one under a public slug on the apps domain, unpublish. Existence of an
// app is the folder in the workspace file area (agents create apps with
// ordinary file tools); these tools only flip the publication fact and
// enumerate. All the rules live in src/apps/management.ts — the same
// functions the /api management surface calls.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolError, toErrorResult, toStructuredResult } from '../src/capabilities/tool-result.ts';
import { config } from '../src/config/index.ts';
import { AppManagementError, listApps, publishApp, unpublishApp } from '../src/apps/management.ts';
import { callerUserId, serveMcp } from './workspace_shared.ts';

function publicUrl(slug: string): string {
  return config.appsDomain ? `https://${config.appsDomain}/${slug}` : slug;
}

function ownerUrl(path: string): string {
  return `https://${config.domain}/apps/${path.split('/').map(encodeURIComponent).join('/')}`;
}

async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof AppManagementError) {
      throw new ToolError(error.message, { kind: 'bad_request' });
    }

    throw error;
  }
}

function createMcpServer() {
  const server = new McpServer({ name: 'apps', version: '1.0.0' });

  server.registerTool(
    'apps_list',
    {
      description:
        'List the mini-apps of this workspace: every folder in the workspace file area carrying a ' +
        'balabash-app.json manifest. Each entry has the folder path, the manifest name/description (or the ' +
        'manifest error), the owner URL to open the app, and — when published — the public slug and URL. ' +
        'Publication state changes via apps_publish / apps_unpublish.',
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        const userId = callerUserId(extra);
        const apps = await listApps(userId);

        return toStructuredResult({
          apps: apps.map(app => ({
            ...app,
            ownerUrl: ownerUrl(app.path),
            publicUrl: app.slug ? publicUrl(app.slug) : null,
          })),
        });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'apps_publish',
    {
      description:
        'Publish a mini-app: make the app folder publicly reachable at https://<apps domain>/<slug> for ' +
        'anyone, no authorization. The slug is chosen here: lowercase [a-z0-9-], globally unique; pick a ' +
        'human-readable one (or a uuid for an unguessable link). Fails with the reason when the slug is ' +
        'taken or reserved, or the manifest is broken. Publication is reversible with apps_unpublish; ' +
        'deleting the app folder also kills the public URL (404).',
      inputSchema: {
        path: z.string().describe('Workspace-relative path of the app folder (as in apps_list).'),
        slug: z.string().describe('The public slug: lowercase letters, digits, hyphens; globally unique.'),
      },
    },
    async ({ path, slug }, extra) => {
      try {
        const userId = callerUserId(extra);
        const result = await guarded(() => publishApp(userId, path, slug));

        return toStructuredResult({ ...result, publicUrl: publicUrl(result.slug) });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'apps_unpublish',
    {
      description:
        'Unpublish a mini-app: the public URL answers 404 from now on. Identify the app by its folder path ' +
        'or by its public slug (either one). The folder and the app itself are untouched — only the ' +
        'publication fact is removed.',
      inputSchema: {
        path: z.string().nullable().describe('Workspace-relative path of the app folder, or null when slug is given.'),
        slug: z.string().nullable().describe('The public slug, or null when path is given.'),
      },
    },
    async ({ path, slug }, extra) => {
      try {
        const userId = callerUserId(extra);
        const result = await guarded(() => unpublishApp(userId, path ?? undefined, slug ?? undefined));

        return toStructuredResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  return server;
}

export async function start() {
  return serveMcp(() => createMcpServer());
}
