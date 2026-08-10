// Status pages of the OAuth landing (§11.4): plain HTML, no templating —
// escapeHtml is the whole engine. Error pages expose only error.message,
// never a stack. The secret forms that used to live here moved behind the
// session into the Next.js app (/secrets/<requestId>).

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

export function renderConnectionCompletedMessage(server: string): string {
  return `Balabash is now connected to <b>${escapeHtml(server)}</b>. You can close this tab and return to the chat.`;
}
