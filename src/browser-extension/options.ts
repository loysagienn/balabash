// The options page: where the server is, the token, the name of this
// browser, the pause — and what the link is doing now. The settings live in
// chrome.storage.local; the worker follows their changes by itself.

import { readSettings } from './link.ts';
import type { LinkStatus } from './link.ts';

const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const serverUrl = field<HTMLInputElement>('serverUrl');
const token = field<HTMLInputElement>('token');
const name = field<HTMLInputElement>('name');
const paused = field<HTMLInputElement>('paused');
const status = field<HTMLDivElement>('status');

const STATE_TEXT: Record<LinkStatus['state'], string> = {
  unconfigured: 'Not connected: enter the server and the token.',
  paused: 'Paused: the server cannot reach this browser.',
  connecting: 'Connecting…',
  connected: 'Connected.',
  offline: 'Not connected, trying again.',
};

async function showStatus(): Promise<void> {
  const current: LinkStatus | undefined = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => undefined);

  if (!current) {
    return;
  }

  const sessions = current.sessions.map(session => `\n${session.clientName}: ${session.tabIds.length} tab(s)`).join('');

  status.dataset.state = current.state;
  status.textContent = STATE_TEXT[current.state] + (current.detail ? `\n${current.detail}` : '') + sessions;
}

async function save(): Promise<void> {
  await chrome.storage.local.set({
    serverUrl: serverUrl.value.trim(),
    token: token.value.trim(),
    name: name.value.trim(),
    paused: paused.checked,
  });
}

const settings = await readSettings();

serverUrl.value = settings.serverUrl;
token.value = settings.token;
name.value = settings.name;
paused.checked = settings.paused;

field<HTMLButtonElement>('save').addEventListener('click', () => void save());
paused.addEventListener('change', () => void save());
setInterval(() => void showStatus(), 1000);
void showStatus();
