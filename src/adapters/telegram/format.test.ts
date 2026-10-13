// Agent Markdown for Telegram rich messages: the text travels as written
// except `<` outside code (escaped) and single line breaks inside paragraphs
// (hard breaks); wide tables become code; a text over the limits is split
// at block boundaries without breaking a block.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatTelegramMarkdown, prepareRichMarkdown, splitRichMarkdown } from './format.ts';

describe('prepareRichMarkdown', () => {
  it('leaves ordinary Markdown, tables included, as written', () => {
    const source = [
      '# Итог',
      '',
      'Текст с **жирным** и `кодом`.',
      '',
      '| Метрика | Значение |',
      '|:--|--:|',
      '| A | **1** |',
      '',
      '- пункт',
      '- [x] сделано',
    ].join('\n');

    assert.equal(prepareRichMarkdown(source), source);
  });

  it('escapes < outside code and keeps it inside code', () => {
    assert.equal(
      prepareRichMarkdown('Array<string> и `Map<K, V>`, <div>x</div>'),
      'Array&lt;string> и `Map<K, V>`, &lt;div>x&lt;/div>',
    );
    assert.equal(
      prepareRichMarkdown('```ts\nconst a: Array<string> = [];\n```'),
      '```ts\nconst a: Array<string> = [];\n```',
    );
  });

  it('keeps autolinks and drops an agent backslash before <', () => {
    assert.equal(prepareRichMarkdown('<https://example.com/a?b=1>'), '<https://example.com/a?b=1>');
    assert.equal(prepareRichMarkdown('<me@example.com>'), '<me@example.com>');
    assert.equal(prepareRichMarkdown('a \\<b\\>'), 'a &lt;b\\>');
  });

  it('turns single line breaks inside a paragraph into hard breaks', () => {
    assert.equal(prepareRichMarkdown('строка A\nстрока B\nстрока C'), 'строка A  \nстрока B  \nстрока C');
    assert.equal(prepareRichMarkdown('- пункт\n  продолжение\n- второй'), '- пункт  \n  продолжение\n- второй');
    assert.equal(prepareRichMarkdown('> цитата\n> дальше'), '> цитата  \n> дальше');
  });

  it('does not add a break where one exists, at a paragraph end or inside code', () => {
    assert.equal(prepareRichMarkdown('A  \nB'), 'A  \nB');
    assert.equal(prepareRichMarkdown('A\\\nB'), 'A\\\nB');
    assert.equal(prepareRichMarkdown('абзац\n\nдругой'), 'абзац\n\nдругой');
    assert.equal(prepareRichMarkdown('`code\nspan` end'), '`code\nspan` end');
    assert.equal(prepareRichMarkdown('# Заголовок\nтекст'), '# Заголовок\nтекст');
  });

  it('sends a table wider than 20 columns as a code block', () => {
    const header = `|${Array.from({ length: 21 }, (_, index) => ` c${index} `).join('|')}|`;
    const rule = `|${Array.from({ length: 21 }, () => '---').join('|')}|`;
    const row = `|${Array.from({ length: 21 }, () => ' <x> ').join('|')}|`;
    const table = [header, rule, row].join('\n');

    assert.equal(prepareRichMarkdown(`До\n\n${table}\n\nПосле`), `До\n\n\`\`\`\n${table}\n\`\`\`\n\nПосле`);
  });
});

describe('splitRichMarkdown', () => {
  const limits = { maxChars: 100, maxBlocks: 10 };

  it('keeps a text within the limits whole', () => {
    assert.deepEqual(splitRichMarkdown('# A\n\ntext', limits), ['# A\n\ntext']);
    assert.deepEqual(splitRichMarkdown('  \n', limits), []);
  });

  it('splits at top-level block boundaries', () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `${index}`.repeat(30));
    const chunks = splitRichMarkdown(paragraphs.join('\n\n'), limits);

    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => chunk.length <= limits.maxChars));
    assert.equal(chunks.join('\n\n'), paragraphs.join('\n\n'));
  });

  it('splits by the block count too', () => {
    const items = Array.from({ length: 12 }, (_, index) => `Абзац ${index}`);
    const chunks = splitRichMarkdown(items.join('\n\n'), { maxChars: 10_000, maxBlocks: 5 });

    assert.ok(chunks.length >= 3);
    assert.equal(chunks.join('\n\n'), items.join('\n\n'));
  });

  it('repeats the header of a split table', () => {
    const rows = Array.from({ length: 10 }, (_, index) => `| r${index} | ${'v'.repeat(10)} |`);
    const table = ['| A | B |', '|---|---|', ...rows].join('\n');
    const chunks = splitRichMarkdown(table, limits);

    assert.ok(chunks.length > 1);

    for (const chunk of chunks) {
      assert.ok(chunk.startsWith('| A | B |\n|---|---|\n| r'));
      assert.ok(chunk.length <= limits.maxChars);
    }

    assert.deepEqual(
      chunks.flatMap(chunk => chunk.split('\n').slice(2)),
      rows,
    );
  });

  it('re-fences a split code block', () => {
    const code = Array.from({ length: 12 }, (_, index) => `line ${index} ${'x'.repeat(10)}`);
    const chunks = splitRichMarkdown(`\`\`\`ts\n${code.join('\n')}\n\`\`\``, limits);

    assert.ok(chunks.length > 1);

    for (const chunk of chunks) {
      assert.match(chunk, /^```ts\n[\s\S]+\n```$/);
      assert.ok(chunk.length <= limits.maxChars);
    }

    assert.deepEqual(
      chunks.flatMap(chunk => chunk.split('\n').slice(1, -1)),
      code,
    );
  });

  it('splits a list at item boundaries', () => {
    const items = Array.from({ length: 10 }, (_, index) => `${index + 1}. пункт ${'z'.repeat(12)}`);
    const chunks = splitRichMarkdown(items.join('\n'), limits);

    assert.ok(chunks.length > 1);
    assert.deepEqual(
      chunks.flatMap(chunk => chunk.split('\n')),
      items,
    );
  });

  it('cuts a single line over the limit by characters', () => {
    const line = 'я'.repeat(250);
    const chunks = splitRichMarkdown(line, limits);

    assert.deepEqual(chunks.map(chunk => chunk.length), [100, 100, 50]);
    assert.equal(chunks.join(''), line);
  });
});

describe('formatTelegramMarkdown', () => {
  it('prepares, then splits', () => {
    assert.deepEqual(formatTelegramMarkdown('A<b>\nC'), ['A&lt;b>  \nC']);
  });
});
