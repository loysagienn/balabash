// The choices and the words of the Browsers card (Browsers.logic.ts): the
// panel about the browser the console is open in, the update of its
// extension, the badge and the lines of a row, the rows that changed
// between two reads, the refusals of a name and of a pairing.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrowserView, BrowsersResponse, OtherBrowserView } from '../../../api/contract.ts';
import type { ExtensionPresence } from '../../lib/extension/index.ts';
import {
  archiveLabel,
  browserBadge,
  browserMeta,
  changedRows,
  defaultBrowserName,
  extensionUpdate,
  herePanel,
  isPausedHere,
  loadFailedWords,
  nameError,
  nameRefusal,
  otherWords,
  outdatedLine,
  pairErrorWords,
  pairingRefusedWords,
  rowSignatures,
  thisBrowser,
} from './Browsers.logic.ts';

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

const other = (over: Partial<OtherBrowserView> = {}): OtherBrowserView => ({ id: 'o1', name: 'Chrome on iMac', ownerName: 'Anna', online: true, lastSeenAt: NOW, ...over });

const listing = (browsers: BrowserView[], version: string | null = '0.2.0', others: OtherBrowserView[] = []): BrowsersResponse => ({
  browsers,
  others,
  extension: { id: 'ext', version, size: version ? 217_000 : null },
});

const present = (state: 'unpaired' | 'paused' | 'connecting' | 'connected' | 'offline', browserId: string | null, version = '0.2.0'): ExtensionPresence => ({
  kind: 'present',
  status: { version, state, browserId },
});

const failure = (status: number, code: string) => ({ status, code, message: code });

describe('the panel about this browser', () => {
  it('waits for the extension’s answer; none for a browser that is connected and on here, whatever its link does', () => {
    assert.deepEqual(herePanel(null, listing([])), { kind: 'checking' });
    assert.deepEqual(herePanel(present('connected', 'b1'), listing([browser()])), { kind: 'none' });
    assert.deepEqual(herePanel(present('offline', 'b1'), listing([browser({ online: false })])), { kind: 'none' });
  });

  it('a hint outside a desktop Chrome; the installation where the extension is missing — unless the installation has none', () => {
    assert.deepEqual(herePanel({ kind: 'unsupported' }, listing([])), { kind: 'not-chrome' });
    assert.deepEqual(herePanel({ kind: 'missing' }, listing([])), { kind: 'no-ext' });
    assert.deepEqual(herePanel({ kind: 'missing' }, listing([], null)), { kind: 'no-build' });
  });

  it('the name and the connect button for an extension paired with none of the user’s browsers — unpaired, or paired with a record that is not theirs', () => {
    assert.deepEqual(herePanel(present('unpaired', null, '0.7.0'), listing([browser()])), { kind: 'unpaired', version: '0.7.0' });
    assert.deepEqual(herePanel(present('connected', 'someone-elses'), listing([browser()])), { kind: 'unpaired', version: '0.2.0' });
  });

  it('“turn on” for a browser of the user that is off in this workspace — paused or not; the pause of one that is on', () => {
    const elsewhere = browser({ enabledHere: false });

    assert.deepEqual(herePanel(present('connected', 'b1'), listing([elsewhere])), { kind: 'off-here', browser: elsewhere });
    assert.deepEqual(herePanel(present('paused', 'b1'), listing([elsewhere])), { kind: 'off-here', browser: elsewhere });
    assert.deepEqual(herePanel(present('paused', 'b1'), listing([browser()])), { kind: 'paused', browser: browser() });
  });
});

describe('this browser among the listed', () => {
  it('is the record its extension names, when the user has it', () => {
    assert.equal(thisBrowser(present('connected', 'b1'), listing([browser()]))?.id, 'b1');
    assert.equal(thisBrowser(present('connected', 'b2'), listing([browser()])), null);
    assert.equal(thisBrowser({ kind: 'missing' }, listing([browser()])), null);
  });

  it('is on pause only by its extension’s own word', () => {
    assert.equal(isPausedHere(present('paused', 'b1')), true);
    assert.equal(isPausedHere(present('offline', 'b1')), false);
    assert.equal(isPausedHere({ kind: 'missing' }), false);
    assert.equal(isPausedHere(null), false);
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

  it('names the archive with its size when the server weighed it', () => {
    assert.equal(archiveLabel({ id: 'ext', version: '0.7.0', size: 217_000 }), 'balabash-agent-0.7.0.zip · 212 KiB');
    assert.equal(archiveLabel({ id: 'ext', version: '0.7.0', size: null }), 'balabash-agent-0.7.0.zip');
  });
});

describe('a row of the user’s browser', () => {
  const at = (over: Partial<Parameters<typeof browserMeta>[1]> = {}) => ({ here: false, on: true, workspace: 'Personal', now: NOW, ...over });

  it('says online, offline — or paused, for the browser the console is open in', () => {
    assert.deepEqual(browserBadge(true), { state: 'done', label: 'online' });
    assert.deepEqual(browserBadge(false), { state: 'off', label: 'offline' });
    assert.deepEqual(browserBadge(false, true), { state: 'off', label: 'paused' });
  });

  it('names when it was last on the link if it is not there, its extension, and that it is off here', () => {
    assert.equal(browserMeta(browser(), at({ here: true })), 'extension 0.2.0');
    assert.equal(browserMeta(browser({ online: false, lastSeenAt: new Date(NOW.getTime() - 3 * 24 * 3_600_000) }), at()), 'last seen 3 days ago · extension 0.2.0');
    assert.equal(browserMeta(browser({ online: false }), at({ here: true })), 'extension 0.2.0', 'this browser needs no “last seen”');
    assert.equal(browserMeta(browser(), at({ on: false })), 'extension 0.2.0 · off in Personal');
    assert.equal(browserMeta(browser({ online: false, lastSeenAt: null, extensionVersion: null }), at()), 'never online');
  });

  it('has an amber line when its extension is out of date — with where to update it', () => {
    assert.equal(outdatedLine(browser(), false, '0.7.0'), null);
    assert.equal(outdatedLine(browser({ outdated: true }), true, '0.7.0'), 'Out of date — 0.7.0 is on the server.');
    assert.equal(outdatedLine(browser({ outdated: true }), false, '0.7.0'), 'Out of date — update it on that computer to 0.7.0.');
    assert.equal(outdatedLine(browser({ outdated: true }), false, null), null);
  });
});

describe('a row of another member’s browser', () => {
  it('names the owner in the title and under it, with when it was last on the link', () => {
    assert.deepEqual(otherWords(other(), NOW), { title: 'Anna · Chrome on iMac', meta: 'owned by Anna' });
    assert.deepEqual(otherWords(other({ online: false, lastSeenAt: new Date(NOW.getTime() - 26 * 3_600_000) }), NOW), { title: 'Anna · Chrome on iMac', meta: 'owned by Anna · last seen 1 day ago' });
    assert.deepEqual(otherWords(other({ ownerName: null, online: false, lastSeenAt: null }), NOW), { title: 'Chrome on iMac', meta: 'owned by another member · never online' });
  });
});

describe('the rows that changed between two reads of the list', () => {
  it('are none at the first read; then the ones that came, and the ones whose name, link or switch moved', () => {
    const first = rowSignatures(listing([browser(), browser({ id: 'b2', name: 'Home desktop', enabledHere: false })], '0.2.0', [other()]));

    assert.deepEqual(changedRows(null, first), []);
    assert.deepEqual(changedRows(first, first), []);

    const second = rowSignatures(
      listing([browser({ lastSeenAt: new Date(0), extensionVersion: '0.3.0' }), browser({ id: 'b2', name: 'Home desktop', enabledHere: true }), browser({ id: 'b3' })], '0.2.0', [other({ online: false })]),
    );

    assert.deepEqual(changedRows(first, second), ['b2', 'b3', 'o1']);
  });
});

describe('a refused name', () => {
  it('is caught before the call when empty or too long', () => {
    assert.equal(nameError('  '), 'Give it a name, up to 60 characters.');
    assert.equal(nameError('x'.repeat(61)), 'Give it a name, up to 60 characters.');
    assert.equal(nameError(' Chrome on Mac '), null);
  });

  it('is told by the server’s code; another failure is not about the name', () => {
    assert.equal(nameRefusal(' Work laptop ', failure(409, 'name_taken')), 'You already have a browser named “Work laptop”.');
    assert.equal(nameRefusal('', failure(400, 'invalid_name')), 'Give it a name, up to 60 characters.');
    assert.equal(nameRefusal('Work laptop', failure(502, 'bad_gateway')), null);
  });
});

describe('a pairing that did not happen', () => {
  it('says what the server answered to the request of a code', () => {
    assert.equal(pairingRefusedWords(failure(502, 'bad_gateway')), 'The server didn’t accept the connection (HTTP 502). Try again.');
    assert.equal(pairingRefusedWords(failure(0, 'network')), 'The server didn’t answer. Try again.');
  });

  it('says what the extension answered — or that it did not', () => {
    assert.equal(pairErrorWords('code_rejected'), 'The server didn’t accept the connection. Try again.');
    assert.equal(pairErrorWords('unsupported_protocol'), 'This extension is too old for the server. Update it with the panel above, then connect.');
    assert.equal(pairErrorWords('unreachable'), 'The extension couldn’t reach the server. Check that this computer is online, then try again.');
    assert.equal(pairErrorWords('no_answer'), 'The extension didn’t answer. Reload it on chrome://extensions and try again.');
  });
});

describe('a list that was not read', () => {
  it('says the status and the code, and that the browsers keep working', () => {
    assert.equal(loadFailedWords(failure(502, 'bad_gateway')), 'HTTP 502 · bad_gateway. Your browsers keep working; this page just can’t show them.');
    assert.equal(loadFailedWords(failure(0, 'network')), 'No answer from the server. Your browsers keep working; this page just can’t show them.');
  });
});

describe('the name a new browser is offered', () => {
  it('says the system when the user agent names one', () => {
    assert.equal(defaultBrowserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/158.0.0.0 Safari/537.36'), 'Chrome on Mac');
    assert.equal(defaultBrowserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/158.0.0.0'), 'Chrome on Windows');
    assert.equal(defaultBrowserName('something else'), 'Chrome');
  });
});
