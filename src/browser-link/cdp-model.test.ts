// The model of a browser a Playwright client sees through a session link
// (cdp-model.ts), with a test playing the extension: what attaching to a
// tab asks of the extension.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCdpModel } from './cdp-model.ts';
import type { CdpMessage } from './cdp-model.ts';

function stand(refuse: (cdpMethod: string) => boolean = () => false) {
  const sent: [string, unknown][] = [];
  const toClient: CdpMessage[] = [];
  const model = createCdpModel(async (method, params) => {
    const cdpMethod = method === 'chrome.debugger.sendCommand' ? String(params[1]) : method;

    sent.push([cdpMethod, method === 'chrome.debugger.sendCommand' ? params[2] : params[0]]);

    if (refuse(cdpMethod)) {
      throw new Error(`${cdpMethod} refused`);
    }

    return cdpMethod === 'Target.getTargetInfo' ? { targetInfo: { targetId: 'T1', type: 'page' } } : {};
  });

  model.setClient(message => toClient.push(message));

  return { model, sent, toClient };
}

describe('attaching to a tab of the session', () => {
  test('turns focus emulation on before the client hears of the tab: a background tab must not sleep', async () => {
    const { model, sent, toClient } = stand();

    model.handleExtensionEvent('chrome.tabs.onCreated', [{ id: 7 }]);
    await model.handleCommand('Target.setAutoAttach', { autoAttach: true }, undefined);

    assert.deepEqual(sent, [
      ['chrome.debugger.attach', { tabId: 7 }],
      ['Target.getTargetInfo', undefined],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
    ]);
    assert.deepEqual(toClient.map(message => message.method), ['Target.attachedToTarget']);
    assert.equal((toClient[0].params as { sessionId: string }).sessionId, 'tab-1');
  });

  test('goes on when the browser refuses the emulation', async () => {
    const { model, toClient } = stand(method => method === 'Emulation.setFocusEmulationEnabled');

    model.handleExtensionEvent('chrome.tabs.onCreated', [{ id: 7 }]);
    await model.handleCommand('Target.setAutoAttach', { autoAttach: true }, undefined);
    assert.deepEqual(toClient.map(message => message.method), ['Target.attachedToTarget']);
  });
});
