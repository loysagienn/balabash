// Server-rendered pages of the provisioning and OAuth flows (§11.4): plain
// HTML, no templating — escapeHtml is the whole engine. Error pages expose
// only error.message, never a stack.

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderStatusPage(title: string, message: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${title}</title>`,
    '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto 0;padding:0 1rem;line-height:1.5}</style>',
    '</head>',
    '<body>',
    `<h1>${title}</h1>`,
    `<p>${message}</p>`,
    '</body>',
    '</html>',
  ].join('\n');
}

export function renderSafeErrorPage(title: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return renderStatusPage(title, escapeHtml(message));
}

export function renderOauthClientForm(server: string, nonce: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>OAuth client setup</title>',
    '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:10vh auto 0;padding:0 1rem;line-height:1.5}label{display:block;margin:1rem 0}.field{display:block;width:100%;box-sizing:border-box;padding:.65rem;margin-top:.35rem}button{padding:.65rem 1rem}</style>',
    '</head>',
    '<body>',
    '<h1>OAuth client setup</h1>',
    `<p>Enter the installation-level OAuth client for <b>${escapeHtml(server)}</b>. Values are stored directly and are not sent to the assistant or event log.</p>`,
    `<form method="post" action="/oauth-client/${encodeURIComponent(server)}?nonce=${encodeURIComponent(nonce)}">`,
    '<label>Client ID<input class="field" name="client_id" required autocomplete="off" /></label>',
    '<label>Client secret (leave empty for a public client)<input class="field" type="password" name="client_secret" autocomplete="new-password" /></label>',
    '<button type="submit">Save OAuth client</button>',
    '</form>',
    '</body>',
    '</html>',
  ].join('\n');
}

export function renderExternalServerCredentialsForm(
  server: string,
  nonce: string,
  fields: Array<{ key: string; description: string }>,
): string {
  const inputs = fields
    .map(
      field =>
        `<label>${escapeHtml(field.key)}<small>${escapeHtml(field.description)}</small><input class="field" type="password" name="${escapeHtml(field.key)}" required autocomplete="new-password" /></label>`,
    )
    .join('\n');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>External server credentials</title>',
    '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:10vh auto 0;padding:0 1rem;line-height:1.5}label{display:block;margin:1rem 0}small{display:block;color:#555}.field{display:block;width:100%;box-sizing:border-box;padding:.65rem;margin-top:.35rem}button{padding:.65rem 1rem}</style>',
    '</head>',
    '<body>',
    '<h1>External server credentials</h1>',
    `<p>Enter the installation credentials for <b>${escapeHtml(server)}</b>. Values are stored directly and are not sent to the assistant or event log.</p>`,
    `<form method="post" action="/external-server-credentials/${encodeURIComponent(server)}?nonce=${encodeURIComponent(nonce)}">`,
    inputs,
    '<button type="submit">Save credentials</button>',
    '</form>',
    '</body>',
    '</html>',
  ].join('\n');
}

export function renderIntegrationReadyMessage(kind: string, server: string): string {
  return `The installation ${kind} for <b>${escapeHtml(server)}</b> is ready. You can close this tab and return to the chat.`;
}

export function renderConnectionCompletedMessage(server: string): string {
  return `Balabash is now connected to <b>${escapeHtml(server)}</b>. You can close this tab and return to the chat.`;
}
