// Browser-facing endpoints of the provisioning flows (§10, §11.4):
// - /external-server-credentials/<server>?nonce=… — one-time form for
//   installation secrets, issued by the auth agent.
// The per-user OAuth endpoints (/connect/<server>, /oauth/callback,
// /oauth-client/<server>) join with the connections layer.
//
// Mounted before any session machinery: these hits come from one-time links,
// redirect chains and link previews — the nonce is the credential.

import type { Context, Next } from 'koa';
import { getExternalServerSecretRequest, provisionExternalServerSecrets } from '../capabilities/external-secrets.ts';
import {
  renderExternalServerCredentialsForm,
  renderIntegrationReadyMessage,
  renderSafeErrorPage,
  renderStatusPage,
} from './pages.ts';

const EXTERNAL_SERVER_CREDENTIALS_PATH_PATTERN = /^\/external-server-credentials\/([a-z][a-z0-9_]*)$/;

async function readFormBody(ctx: Context): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];

  for await (const chunk of ctx.req) {
    chunks.push(chunk as Buffer);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export const connect = async (ctx: Context, next: Next): Promise<void> => {
  const externalCredentialsMatch = ctx.path.match(EXTERNAL_SERVER_CREDENTIALS_PATH_PATTERN);

  if (externalCredentialsMatch && (ctx.method === 'GET' || ctx.method === 'POST')) {
    const server = externalCredentialsMatch[1];
    const nonce = typeof ctx.query.nonce === 'string' ? ctx.query.nonce : '';

    try {
      const request = await getExternalServerSecretRequest(server, nonce);

      if (ctx.method === 'GET') {
        ctx.type = 'html';
        ctx.body = renderExternalServerCredentialsForm(request.server, request.nonce, request.fields);
        return;
      }

      const body = await readFormBody(ctx);
      const values = Object.fromEntries(request.fields.map(field => [field.key, body.get(field.key) ?? '']));

      await provisionExternalServerSecrets(request.server, request.nonce, values);
      ctx.type = 'html';
      ctx.body = renderStatusPage('Credentials saved', renderIntegrationReadyMessage('credentials', request.server));
    } catch (error) {
      ctx.status = 400;
      ctx.type = 'html';
      ctx.body = renderSafeErrorPage('Credential setup failed', error);
    }

    return;
  }

  return next();
};
