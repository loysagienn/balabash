// Browser-facing endpoints of the provisioning and per-user OAuth flows
// (§10, §11.4):
// - /external-server-credentials/<server>?nonce=… — one-time form for
//   installation secrets;
// - /oauth-client/<server>?nonce=… — one-time form for a manual
//   installation-level OAuth client;
// - /connect/<server>?nonce=… — entry from the one-time link issued by the
//   auth agent; redirects to the provider's consent page;
// - /oauth/callback — the single registered OAuth redirect URI for every
//   provider; exchanges the code and shows a plain closing page.
//
// Mounted before any session machinery: these hits come from one-time links,
// redirect chains and link previews — the nonce and the OAuth state are the
// credentials.

import type { Context, Next } from 'koa';
import { getExternalServerSecretRequest, provisionExternalServerSecrets } from '../capabilities/external-secrets.ts';
import {
  getOauthClientRequest,
  handleConnectClick,
  handleOauthCallback,
  provisionOauthClient,
} from '../capabilities/connections/index.ts';
import {
  renderConnectionCompletedMessage,
  renderExternalServerCredentialsForm,
  renderIntegrationReadyMessage,
  renderOauthClientForm,
  renderSafeErrorPage,
  renderStatusPage,
} from './pages.ts';

const EXTERNAL_SERVER_CREDENTIALS_PATH_PATTERN = /^\/external-server-credentials\/([a-z][a-z0-9_]*)$/;
const OAUTH_CLIENT_PATH_PATTERN = /^\/oauth-client\/([a-z][a-z0-9_]*)$/;
const CONNECT_PATH_PATTERN = /^\/connect\/([a-z][a-z0-9_]*)$/;

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

  const oauthClientMatch = ctx.path.match(OAUTH_CLIENT_PATH_PATTERN);

  if (oauthClientMatch && (ctx.method === 'GET' || ctx.method === 'POST')) {
    const server = oauthClientMatch[1];
    const nonce = typeof ctx.query.nonce === 'string' ? ctx.query.nonce : '';

    try {
      const request = await getOauthClientRequest(server, nonce);

      if (ctx.method === 'GET') {
        ctx.type = 'html';
        ctx.body = renderOauthClientForm(request.server, request.nonce);
        return;
      }

      const body = await readFormBody(ctx);

      await provisionOauthClient(
        request.server,
        request.nonce,
        body.get('client_id') ?? '',
        body.get('client_secret') ?? '',
      );
      ctx.type = 'html';
      ctx.body = renderStatusPage('OAuth client saved', renderIntegrationReadyMessage('OAuth client', request.server));
    } catch (error) {
      ctx.status = 400;
      ctx.type = 'html';
      ctx.body = renderSafeErrorPage('OAuth client setup failed', error);
    }

    return;
  }

  const connectMatch = ctx.path.match(CONNECT_PATH_PATTERN);

  if (connectMatch && ctx.method === 'GET') {
    const nonce = typeof ctx.query.nonce === 'string' ? ctx.query.nonce : '';

    try {
      ctx.redirect(await handleConnectClick(connectMatch[1], nonce));
    } catch (error) {
      ctx.status = 400;
      ctx.type = 'html';
      ctx.body = renderSafeErrorPage('Authorization failed', error);
    }

    return;
  }

  if (ctx.path === '/oauth/callback' && ctx.method === 'GET') {
    const outcome = await handleOauthCallback(ctx.query as Record<string, unknown>);

    ctx.type = 'html';

    if (outcome.ok) {
      ctx.body = renderStatusPage('Authorization completed', renderConnectionCompletedMessage(outcome.server ?? ''));
    } else {
      ctx.status = 400;
      ctx.body = renderSafeErrorPage('Authorization failed', outcome.error ?? 'Unknown error');
    }

    return;
  }

  return next();
};
