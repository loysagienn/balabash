import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNumeric, parseDelimited } from './csv.ts';
import { codeLines, splitHighlighted } from './codeLines.ts';
import { crumbSegments, listingSummary, nameOf, parentOf, viewerFor, TEXT_PREVIEW_MAX } from './node.ts';

const file = (path: string, mediaType: string, sizeBytes = 100) => ({ path, mediaType, sizeBytes });

describe('file area — node rules', () => {
  it('splits paths', () => {
    assert.equal(parentOf('a/b/c.md'), 'a/b');
    assert.equal(parentOf('c.md'), '');
    assert.equal(nameOf('a/b/c.md'), 'c.md');
    assert.deepEqual(crumbSegments('', 'a/b/c.md'), ['a', 'b', 'c.md']);
    assert.deepEqual(crumbSegments('', ''), []);
    assert.deepEqual(crumbSegments('proj', 'proj/inbox.md'), ['inbox.md']);
    assert.deepEqual(crumbSegments('proj', 'proj'), []);
  });

  it('picks the viewer by type, extension and size', () => {
    assert.deepEqual(viewerFor(file('notes/plan.md', 'text/markdown')), { kind: 'markdown' });
    assert.deepEqual(viewerFor(file('src/a.ts', 'text/typescript')), { kind: 'code', language: 'typescript' });
    assert.deepEqual(viewerFor(file('page.html', 'text/html')), { kind: 'code', language: 'xml' });
    assert.deepEqual(viewerFor(file('x.log', 'text/plain')), { kind: 'code', language: null });
    assert.deepEqual(viewerFor(file('.env', 'application/octet-stream')), { kind: 'code', language: null });
    assert.deepEqual(viewerFor(file('data.csv', 'text/csv')), { kind: 'csv', delimiter: ',' });
    assert.deepEqual(viewerFor(file('data.tsv', 'text/tab-separated-values')), { kind: 'csv', delimiter: '\t' });
    assert.deepEqual(viewerFor(file('a.png', 'image/png')), { kind: 'image' });
    assert.deepEqual(viewerFor(file('a.pdf', 'application/pdf')), { kind: 'pdf' });
    assert.deepEqual(viewerFor(file('a.zip', 'application/zip')), { kind: 'none', reason: 'type' });
    assert.deepEqual(viewerFor(file('a.mp4', 'video/mp4')), { kind: 'none', reason: 'type' });
    assert.deepEqual(viewerFor(file('server.log', 'text/plain', TEXT_PREVIEW_MAX + 1)), { kind: 'none', reason: 'size' });
    assert.deepEqual(viewerFor(file('huge.png', 'image/png', TEXT_PREVIEW_MAX * 10)), { kind: 'image' });
  });

  it('sums the footer', () => {
    assert.equal(listingSummary({ directories: ['a', 'b'], files: [{ ...file('x', 't', 1024) } as never, { ...file('y', 't', 1024) } as never] }), '2 folders · 2 files · 2.0 KiB');
    assert.equal(listingSummary({ directories: [], files: [] }), '0 folders · 0 files');
    assert.equal(listingSummary({ directories: ['a'], files: [{ ...file('x', 't', null as never) } as never] }), '1 folder · 1 file');
  });
});

describe('file area — delimited text', () => {
  it('parses quotes, line breaks inside quotes and caps the rows', () => {
    const table = parseDelimited('name,amount\n"Smith, J",10\n"say ""hi""\nthere",2.5\nx,3\n', ',', 2);

    assert.deepEqual(table.header, ['name', 'amount']);
    assert.deepEqual(table.rows, [
      ['Smith, J', '10'],
      ['say "hi"\nthere', '2.5'],
    ]);
    assert.equal(table.total, 3);
    assert.equal(table.truncated, true);
  });

  it('handles CRLF, tabs and a missing trailing newline', () => {
    const table = parseDelimited('a\tb\r\n1\t2\r\n3\t4', '\t', 100);

    assert.deepEqual(table.header, ['a', 'b']);
    assert.deepEqual(table.rows, [
      ['1', '2'],
      ['3', '4'],
    ]);
    assert.equal(table.truncated, false);
    assert.deepEqual(parseDelimited('', ',', 10), { header: [], rows: [], total: 0, truncated: false });
  });

  it('tells numbers from text', () => {
    assert.equal(isNumeric('1,312'), true);
    assert.equal(isNumeric('-2.5'), true);
    assert.equal(isNumeric('12%'), true);
    assert.equal(isNumeric('Oct 2'), false);
    assert.equal(isNumeric(''), false);
  });
});

describe('file area — code lines', () => {
  it('closes and reopens spans across line breaks', () => {
    assert.deepEqual(splitHighlighted('<span class="a">x\ny</span>\nz'), ['<span class="a">x</span>', '<span class="a">y</span>', 'z']);
    assert.deepEqual(splitHighlighted('<span class="a"><span class="b">1\n2</span>3</span>'), ['<span class="a"><span class="b">1</span></span>', '<span class="a"><span class="b">2</span>3</span>']);
    assert.deepEqual(splitHighlighted(''), ['']);
  });

  it('highlights a known grammar and escapes plain text', () => {
    const lines = codeLines('const a = 1;\n// two\n', 'typescript', true);

    assert.equal(lines.length, 2);
    assert.match(lines[0] as string, /hljs-keyword/);
    assert.match(lines[1] as string, /hljs-comment/);
    assert.deepEqual(codeLines('a < b\n\nc', null, true), ['a &lt; b', '', 'c']);
    assert.deepEqual(codeLines('x = 1', 'python', false), ['x = 1']);
    assert.deepEqual(codeLines('', null, true), ['']);
  });
});
