// The theme choice (lib/theme) over fake storage and a fake document, and
// the shell's boot script (src/utils/console-themes.ts): what each theme
// puts on the page.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, THEME_STORAGE_KEY, themeBootScript } from '../../../utils/console-themes.ts';
import { applyTheme, pageTheme, readTheme, writeTheme } from './index.ts';

function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));

  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const refusing = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

// A document of the shell's head: <html> and the two metas.
function fakeDocument() {
  const attrs = new Map<string, string>();
  const metas: Record<string, string> = { 'theme-color': '#0c0d0f', 'color-scheme': 'dark' };
  const meta = (name: string) => ({ setAttribute: (_attr: string, value: string) => void (metas[name] = value) });

  return {
    attrs,
    metas,
    doc: {
      documentElement: { setAttribute: (name: string, value: string) => void attrs.set(name, value), removeAttribute: (name: string) => void attrs.delete(name) },
      querySelector: (selector: string) => (selector.includes('theme-color') ? meta('theme-color') : selector.includes('color-scheme') ? meta('color-scheme') : null),
    } as unknown as Document,
  };
}

describe('the theme choice', () => {
  it('reads a stored theme; anything else and refusing storage are Graphite', () => {
    assert.equal(readTheme(memory({ [THEME_STORAGE_KEY]: 'paper' })), 'paper');
    assert.equal(readTheme(memory({ [THEME_STORAGE_KEY]: 'neon' })), 'graphite');
    assert.equal(readTheme(memory()), 'graphite');
    assert.equal(readTheme(refusing), 'graphite');
    assert.equal(readTheme(null), 'graphite');
  });

  it('writes the choice, Graphite included, and survives refusing storage', () => {
    const store = memory();

    writeTheme('dusk', store);
    assert.equal(store.items.get(THEME_STORAGE_KEY), 'dusk');
    writeTheme('graphite', store);
    assert.equal(store.items.get(THEME_STORAGE_KEY), 'graphite');
    assert.doesNotThrow(() => writeTheme('light', refusing));
  });

  it('puts the theme on the page: no attribute for Graphite, the theme’s --bg and scheme in the metas', () => {
    assert.deepEqual(pageTheme('graphite'), { attribute: null, themeColor: '#0c0d0f', colorScheme: 'dark' });
    assert.deepEqual(pageTheme('carbon'), { attribute: 'carbon', themeColor: '#000000', colorScheme: 'dark' });
    assert.deepEqual(pageTheme('light'), { attribute: 'light', themeColor: '#f3f4f6', colorScheme: 'light' });

    const page = fakeDocument();

    applyTheme('paper', page.doc);
    assert.equal(page.attrs.get('data-bb-theme'), 'paper');
    assert.equal(page.metas['theme-color'], '#f2efe7');
    assert.equal(page.metas['color-scheme'], 'light');

    applyTheme('graphite', page.doc);
    assert.equal(page.attrs.has('data-bb-theme'), false);
    assert.equal(page.metas['theme-color'], '#0c0d0f');
    assert.equal(page.metas['color-scheme'], 'dark');
  });
});

describe('the shell’s boot script', () => {
  it('names the storage key and every theme but Graphite with its page color and scheme', () => {
    const script = themeBootScript();

    assert.match(script, /localStorage\.getItem\("balabash\.theme"\)/);
    assert.match(script, /data-bb-theme/);

    for (const theme of THEMES) {
      if (theme.id === 'graphite') {
        assert.doesNotMatch(script, /"graphite"/);
      } else {
        assert.ok(script.includes(`"${theme.id}":["${theme.bg}","${theme.scheme}"]`), theme.id);
      }
    }
  });

  it('runs as plain script: sets the attribute and the metas for a stored theme, leaves Graphite alone', () => {
    const run = (stored: string | null) => {
      const attrs = new Map<string, string>();
      const metas: Record<string, string> = { 'theme-color': '#0c0d0f', 'color-scheme': 'dark' };
      const document = {
        documentElement: { setAttribute: (name: string, value: string) => void attrs.set(name, value) },
        querySelector: (selector: string) => {
          const name = selector.includes('theme-color') ? 'theme-color' : 'color-scheme';

          return { setAttribute: (_attr: string, value: string) => void (metas[name] = value) };
        },
      };
      const localStorage = { getItem: () => stored };

      new Function('document', 'localStorage', themeBootScript())(document, localStorage);

      return { attrs, metas };
    };

    const light = run('light');

    assert.equal(light.attrs.get('data-bb-theme'), 'light');
    assert.deepEqual(light.metas, { 'theme-color': '#f3f4f6', 'color-scheme': 'light' });

    const carbon = run('carbon');

    assert.equal(carbon.attrs.get('data-bb-theme'), 'carbon');
    assert.deepEqual(carbon.metas, { 'theme-color': '#000000', 'color-scheme': 'dark' });

    for (const stored of [null, 'graphite', 'neon']) {
      const page = run(stored);

      assert.equal(page.attrs.size, 0, String(stored));
      assert.deepEqual(page.metas, { 'theme-color': '#0c0d0f', 'color-scheme': 'dark' });
    }
  });
});
