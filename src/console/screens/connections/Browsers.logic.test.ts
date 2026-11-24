// The choices of the Browsers section (Browsers.logic.ts): what the screen
// offers about the browser it is open in, the update of its extension, the
// meta line of a browser.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrowserView, BrowsersResponse } from '../../../api/contract.ts';
import type { ExtensionPresence } from '../../lib/extension/index.ts';
import { browserMeta, defaultBrowserName, extensionUpdate, thisBrowser, thisBrowserOffer } from './Browsers.logic.ts';

const NOW = new Date('2026-11-24T12:00:00Z');

const browser = (over: Partial<BrowserView> = {}): BrowserView => ({
  id: 'b1',
  name: 'MacBook',
  online: true,
  lastSeenAt: NOW,
  extensionVersion: '0.2.0',
  outdated: false,
  enabledHere: true,
  ...over,
});

const listing = (browsers: BrowserView[], version: string | null = '0.2.0'): BrowsersResponse => ({ browsers, others: [], extension: { id: 'ext', version } });

const present = (state: 'unpaired' | 'paused' | 'connecting' | 'connected' | 'offline', browserId: string | null, version = '0.2.0'): ExtensionPresence => ({
  kind: 'present',
  status: { version, state, browserId },
});

describe('what the screen offers about this browser', () => {
  it('nothing until the extension was asked, and nothing for a browser that is connected and enabled here', () => {
    assert.deepEqual(thisBrowserOffer(null, listing([])), { kind: 'nothing' });
    assert.deepEqual(thisBrowserOffer(present('connected', 'b1'), listing([browser()])), { kind: 'nothing' });
    assert.deepEqual(thisBrowserOffer(present('offline', 'b1'), listing([browser({ online: false })])), { kind: 'nothing' });
  });

  it('a hint outside a desktop Chrome; the download where the extension is missing — unless the installation has none', () => {
    assert.deepEqual(thisBrowserOffer({ kind: 'unsupported' }, listing([])), { kind: 'unsupported' });
    assert.deepEqual(thisBrowserOffer({ kind: 'missing' }, listing([])), { kind: 'install' });
    assert.deepEqual(thisBrowserOffer({ kind: 'missing' }, listing([], null)), { kind: 'not-built' });
  });

  it('to connect an extension paired with none of the user’s browsers — unpaired, or paired with a record that is not theirs', () => {
    assert.deepEqual(thisBrowserOffer(present('unpaired', null), listing([browser()])), { kind: 'connect' });
    assert.deepEqual(thisBrowserOffer(present('connected', 'someone-elses'), listing([browser()])), { kind: 'connect' });
  });

  it('to enable a browser of the user that is not enabled in this workspace; a word about the pause of one that is', () => {
    const elsewhere = browser({ enabledHere: false });

    assert.deepEqual(thisBrowserOffer(present('connected', 'b1'), listing([elsewhere])), { kind: 'enable', browser: elsewhere });
    assert.deepEqual(thisBrowserOffer(present('paused', 'b1'), listing([browser()])), { kind: 'paused', browser: browser() });
  });
});

describe('this browser among the listed', () => {
  it('is the record its extension names, when the user has it', () => {
    assert.equal(thisBrowser(present('connected', 'b1'), listing([browser()]))?.id, 'b1');
    assert.equal(thisBrowser(present('connected', 'b2'), listing([browser()])), null);
    assert.equal(thisBrowser({ kind: 'missing' }, listing([browser()])), null);
  });
});

describe('the update of this browser’s extension', () => {
  it('is offered only when the installed one is older than the installation’s', () => {
    assert.deepEqual(extensionUpdate(present('connected', 'b1', '0.1.9'), listing([], '0.2.0')), { installed: '0.1.9', current: '0.2.0' });
    assert.equal(extensionUpdate(present('connected', 'b1', '0.2.0'), listing([], '0.2.0')), null);
    assert.equal(extensionUpdate(present('connected', 'b1', '0.10.0'), listing([], '0.9.0')), null);
    assert.equal(extensionUpdate(present('connected', 'b1', '0.1.0'), listing([], null)), null);
    assert.equal(extensionUpdate({ kind: 'missing' }, listing([], '0.2.0')), null);
  });
});

describe('the meta line of a browser', () => {
  it('names what sets it apart and, off the link, when it was last there', () => {
    assert.equal(browserMeta(browser(), true, NOW), 'this browser · extension 0.2.0');
    assert.equal(
      browserMeta(browser({ online: false, enabledHere: false, outdated: true, lastSeenAt: new Date(NOW.getTime() - 7 * 60_000) }), false, NOW),
      'not enabled in this workspace · extension 0.2.0 (outdated) · last online 7 min ago',
    );
    assert.equal(browserMeta(browser({ online: false, lastSeenAt: null, extensionVersion: null }), false, NOW), 'never online');
  });
});

describe('the name a new browser is offered', () => {
  it('says the system when the user agent names one', () => {
    assert.equal(defaultBrowserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/158.0.0.0 Safari/537.36'), 'Chrome on Mac');
    assert.equal(defaultBrowserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/158.0.0.0'), 'Chrome on Windows');
    assert.equal(defaultBrowserName('something else'), 'Chrome');
  });
});
