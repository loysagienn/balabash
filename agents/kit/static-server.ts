// A loopback static file server over a directory of the workbench, for the
// agents that render their own files in their own browser (the designer): a
// local render of an HTML page needs an http origin — the Playwright MCP
// blocks file:// navigation, and a page on file:// could not fetch its own
// sibling files anyway (Chromium treats a file:// origin as opaque), which is
// how the design runtime loads imported components.
//
// Per run: the agent's environment starts one, hands its address to the
// session (SessionEnvironment.instructions) and closes it with the session.
// The address is ephemeral (127.0.0.1, a port of the OS's choice), so several
// sessions on one host never collide. Loopback only: the files are the
// user's own workbench, and the only client is the session's browser.
//
// GET and HEAD, paths confined to the root (a request that resolves outside
// it is a 404 like any missing file), a directory answers with its
// index.html when it has one. Every answer is `Cache-Control: no-store`: the
// agent edits a file and renders it again right away — a cached stylesheet
// would show it a stale page and send it chasing a bug that is already fixed.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export type StaticServer = {
  url: string; // http://127.0.0.1:<port> — no trailing slash
  root: string;
  close(): Promise<void>;
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// The file a request path names, or null when the path leaves the root or is
// not decodable. Pure: the caller stats the result.
export function resolveRequestPath(root: string, requestPath: string): string | null {
  let decoded: string;

  try {
    decoded = decodeURIComponent(requestPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }

  if (decoded.includes('\0')) {
    return null;
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);

  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }

  return resolved;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function handle(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');

    return;
  }

  let filePath = resolveRequestPath(root, req.url ?? '/');

  if (!filePath) {
    send(res, 404, 'Not Found');

    return;
  }

  try {
    let info = await stat(filePath);

    if (info.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      info = await stat(filePath);
    }

    if (!info.isFile()) {
      send(res, 404, 'Not Found');

      return;
    }

    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });

    if (req.method === 'HEAD') {
      res.end();

      return;
    }

    const stream = createReadStream(filePath);

    stream.on('error', () => {
      res.destroy();
    });
    stream.pipe(res);
  } catch {
    send(res, 404, 'Not Found');
  }
}

export async function startStaticServer(options: { root: string }): Promise<StaticServer> {
  const root = path.resolve(options.root);
  const server: Server = createServer((req, res) => {
    void handle(root, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    root,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
