// The history process over a fake window: what the route and its fragment
// become in history, what a popstate brings back, and how an entry the
// tab did not know gets its id.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Api } from '../api/index.ts';
import { createStore } from '../../store/index.ts';
import { routeTo } from '../../store/router/actions.ts';
import { connectStoreToHistory, urlOf } from './history.ts';
import { readRoute } from './routes.ts';

type Entry = { method: 'push' | 'replace'; state: unknown; url: string };

// The pieces of window the process touches: history writes, the location
// and the popstate listener.
function fakeWindow(pathname: string, search = '', hash = '') {
  const entries: Entry[] = [];
  const listeners = new Set<(event: { state: unknown }) => void>();
  const location = { pathname, search, hash };
  const win = {
    history: {
      pushState: (state: unknown, _title: string, url: string) => {
        entries.push({ method: 'push', state, url });
        const parsed = new URL(url, 'https://console.test');
        Object.assign(location, { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash });
      },
      replaceState: (state: unknown, _title: string, url: string) => {
        entries.push({ method: 'replace', state, url });
        const parsed = new URL(url, 'https://console.test');
        Object.assign(location, { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash });
      },
    },
    location,
    addEventListener: (_type: string, listener: (event: { state: unknown }) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: { state: unknown }) => void) => listeners.delete(listener),
  };

  return { win, entries, location, pop: (state: unknown) => listeners.forEach(listener => listener({ state })) };
}

// The entry's state is the route and the id of the store's page entry.
function stateOf(entry: Entry): { route: unknown; entry: number } {
  const state = entry.state as { route: unknown; entry: unknown };

  assert.equal(typeof state.entry, 'number');

  return state as { route: unknown; entry: number };
}

describe('router — the history process', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('writes the route’s URL with its fragment and reads the fragment back on popstate', () => {
    const { win, entries, location, pop } = fakeWindow('/workspace/a.md', '', '#top');

    (globalThis as { window?: unknown }).window = win;

    const store = createStore({ api: {} as Api, initialRoute: { key: 'files', path: 'a.md' }, initialHash: '#top' });
    const disconnect = connectStoreToHistory(store);

    // The first entry: the route in state, the fragment the tab opened with kept.
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.method, 'replace');
    assert.equal(entries[0]!.url, '/workspace/a.md#top');
    assert.deepEqual(stateOf(entries[0]!).route, { key: 'files', path: 'a.md' });

    const first = stateOf(entries[0]!);

    assert.equal(first.entry, 1);

    // A link to a section of another file: one push, fragment and all, a new entry.
    store.dispatch(routeTo({ key: 'project', slug: 'proj', path: 'next.md' }, { hash: '#part' }));
    assert.equal(entries[1]!.method, 'push');
    assert.equal(entries[1]!.url, '/projects/proj/files/next.md#part');
    assert.deepEqual(stateOf(entries[1]!).route, { key: 'project', slug: 'proj', path: 'next.md' });
    assert.notEqual(stateOf(entries[1]!).entry, first.entry);

    // Another section of the same file: a new entry of the same route.
    store.dispatch(routeTo({ key: 'project', slug: 'proj', path: 'next.md' }, { hash: '#other' }));
    assert.equal(entries[2]!.method, 'push');
    assert.equal(entries[2]!.url, '/projects/proj/files/next.md#other');
    assert.notEqual(stateOf(entries[2]!).entry, stateOf(entries[1]!).entry);

    // The same route and fragment again: nothing to write.
    store.dispatch(routeTo({ key: 'project', slug: 'proj', path: 'next.md' }, { hash: '#other' }));
    assert.equal(entries.length, 3);

    // A replace keeps the entry (the same page); a route without a fragment drops it from the URL.
    store.dispatch(routeTo({ key: 'project', slug: 'proj', path: 'next.md' }, { replace: true }));
    assert.equal(entries[3]!.method, 'replace');
    assert.equal(entries[3]!.url, '/projects/proj/files/next.md');
    assert.equal(stateOf(entries[3]!).entry, stateOf(entries[2]!).entry);

    // Back to the first entry: the route from its state, the fragment from
    // the location; a known entry — a step back, nothing written.
    Object.assign(location, { pathname: '/workspace/a.md', search: '', hash: '#top' });
    pop(first);

    const { route, source, replace, hash, move, index } = store.getState().router;

    assert.deepEqual(
      { route, source, replace, hash, move, index },
      {
        route: { key: 'files', path: 'a.md' },
        source: 'history',
        replace: false,
        hash: '#top',
        move: 'back',
        index: 0,
      },
    );
    assert.equal(entries.length, 4);

    // An entry without a state (the browser's own fragment navigation): the
    // route from the location, a page of its own — and the entry gets an id.
    Object.assign(location, { pathname: '/agents/engineer', search: '?q=en', hash: '#x' });
    pop(null);
    assert.deepEqual(store.getState().router.route, { key: 'agents', name: 'engineer', q: 'en' });
    assert.equal(store.getState().router.hash, '#x');
    assert.equal(store.getState().router.move, 'unknown');
    assert.equal(entries.length, 5);
    assert.equal(entries[4]!.method, 'replace');
    assert.equal(entries[4]!.url, '/agents/engineer?q=en#x');
    assert.equal(stateOf(entries[4]!).entry, store.getState().router.pages[store.getState().router.index]!.entry);

    // Back from it to the first entry again: known, a step back.
    Object.assign(location, { pathname: '/workspace/a.md', search: '', hash: '#top' });
    pop(first);
    assert.equal(store.getState().router.move, 'back');
    assert.equal(entries.length, 5);

    // An entry written by an older build (a string id) is one the tab does not know.
    Object.assign(location, { pathname: '/system', search: '', hash: '' });
    pop({ route: { key: 'system' }, entry: 'old-uuid' });
    assert.equal(store.getState().router.move, 'unknown');
    assert.deepEqual(store.getState().router.route, { key: 'system' });
    assert.equal(entries[5]!.method, 'replace');

    disconnect();
    store.dispatch(routeTo({ key: 'home' }));
    assert.equal(entries.length, 6);
  });

  it('tells two entries of one URL apart: each is its own page', () => {
    // A filtered list (A), the section's own link (B), the filter chosen again
    // on B — a replace gives B the URL of A, under its own id.
    const { win, entries, location, pop } = fakeWindow('/threads', '?agent=engineer');

    (globalThis as { window?: unknown }).window = win;

    const store = createStore({ api: {} as Api, initialRoute: readRoute('/threads?agent=engineer') });
    const disconnect = connectStoreToHistory(store);
    const a = stateOf(entries[0]!);

    store.dispatch(routeTo({ key: 'threads' }));
    assert.equal(entries[1]!.method, 'push');
    assert.equal(entries[1]!.url, '/threads');

    store.dispatch(routeTo(readRoute('/threads?agent=engineer'), { replace: true }));
    assert.equal(entries[2]!.method, 'replace');
    assert.equal(entries[2]!.url, '/threads?agent=engineer');

    const b = stateOf(entries[2]!);

    assert.equal(b.entry, stateOf(entries[1]!).entry);
    assert.notEqual(b.entry, a.entry);

    // Back from B to A: the URL does not change, the state does — a step back to page 1.
    const onB = store.getState().router;

    pop(a);

    const onA = store.getState().router;

    assert.notEqual(onA, onB);
    assert.deepEqual(onA.route, onB.route);
    assert.equal(onA.move, 'back');
    assert.equal(onA.pages[onA.index]!.page, 1);
    assert.equal(entries.length, 3);

    // Forward brings B: another page.
    pop(b);
    assert.equal(store.getState().router.move, 'forward');
    assert.equal(store.getState().router.pages[store.getState().router.index]!.page, 2);
    assert.equal(location.search, '?agent=engineer');

    disconnect();
  });

  it('knows no entry of an earlier load: a page reloaded on a thread, the browser’s back to the list it came from', () => {
    // Before the reload the tab had [threads (1), thread (2)]; the reload
    // makes the thread the first page of a new load — entry 1 again.
    const { win, entries, pop } = fakeWindow('/threads/t1');

    (globalThis as { window?: unknown }).window = win;

    const store = createStore({ api: {} as Api, initialRoute: readRoute('/threads/t1') });
    const disconnect = connectStoreToHistory(store);
    const own = entries[0]!.state as { entry: number; load: string };

    assert.equal(own.entry, 1);
    assert.equal(typeof own.load, 'string');

    // Back: the list's entry carries the number 1 of the earlier load — not this tab's page 1.
    pop({ route: { key: 'threads' }, entry: 1, load: `${own.load}-before` });

    const onList = store.getState().router;

    assert.equal(onList.move, 'unknown');
    assert.equal(onList.pages.length, 2);
    assert.deepEqual(onList.pages[1]!.route, { key: 'threads' });
    assert.deepEqual(onList.pages[0]!.route, { key: 'thread', id: 't1' });

    // The entry gets this load's id; the next return to it is a known move.
    const stamped = entries[1]!.state as { route: unknown; entry: number; load: string };

    assert.equal(entries[1]!.method, 'replace');
    assert.equal(stamped.entry, 2);
    assert.equal(stamped.load, own.load);

    pop(own);
    assert.deepEqual(store.getState().router.route, { key: 'thread', id: 't1' });
    assert.equal(store.getState().router.pages[store.getState().router.index]!.page, 1);
    pop(stamped);
    assert.equal(store.getState().router.move, 'forward');
    assert.equal(store.getState().router.pages.length, 2);

    // An entry without a load at all (written before loads were stamped) is unknown too.
    pop({ route: { key: 'threads' }, entry: 1 });
    assert.equal(store.getState().router.move, 'unknown');

    disconnect();
  });

  it('composes the URL of an entry from the route and the fragment', () => {
    assert.equal(urlOf({ key: 'files', path: 'a b.md' }, '#part'), '/workspace/a%20b.md#part');
    assert.equal(urlOf({ key: 'home' }, ''), '/');
  });
});
