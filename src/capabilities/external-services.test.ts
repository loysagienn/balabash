// Connections still reads installation service status after the tool servers
// are gone. Exercise a credential change and the lifetime of its MCP probe.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { test } from 'node:test';
import { closeServer, listen, startStand } from '../test-support/stand.ts';

test('Connections probes the configured service once per key and releases its MCP session', async t => {
  const stand = await startStand();
  t.after(() => stand.stop());
  const probes: string[] = [];
  const ended: string[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') {
      ended.push(String(req.headers['mcp-session-id']));
      res.writeHead(200).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    const key = String(req.headers.authorization);
    if (message.method === 'initialize') {
      probes.push(key);
      res.setHeader('mcp-session-id', 'probe-session');
    }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'search', version: '1' } }
      : { tools: [] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  const address = await listen(server, 0, '127.0.0.1');
  t.after(() => closeServer(server));
  const url = `http://127.0.0.1:${address.port}/`;
  await fs.mkdir('data/mcp-servers', { recursive: true });
  await fs.writeFile('data/mcp-servers/search.json', JSON.stringify({ transport: 'http', url, headers: { Authorization: 'Bearer ${secret:KEY}' } }));
  await fs.writeFile('data/mcp-servers/wiki.json', JSON.stringify({ transport: 'http', url, auth: 'user', description: 'Wiki' }));
  const { loadExternalServices } = await import('./external-services.ts');
  const { prisma } = await import('../db/client.ts');
  const { getAccountService, refreshSecretServices, getSecretService } = await import('./connections/services.ts');
  await loadExternalServices();
  await refreshSecretServices();
  assert.equal(getAccountService('wiki')?.url, url);
  assert.equal(getSecretService('search')?.connected, false);
  assert.deepEqual(probes, []);
  const data = { server: 'search', key: 'KEY', value: 'first' };
  await prisma.externalServerSecret.create({ data });
  await Promise.all([refreshSecretServices(), refreshSecretServices()]);
  assert.equal(getSecretService('search')?.connected, true);
  await prisma.externalServerSecret.update({ where: { server_key: { server: 'search', key: 'KEY' } }, data: { value: 'next' } });
  await refreshSecretServices();
  assert.deepEqual(ended, ['probe-session', 'probe-session']);
  assert.deepEqual(probes, ['Bearer first', 'Bearer next']);
  const { forgetExternalServerSecrets } = await import('./external-secrets.ts');
  assert.equal(await forgetExternalServerSecrets('search'), 1);
  assert.equal(getSecretService('search')?.connected, false);
});
