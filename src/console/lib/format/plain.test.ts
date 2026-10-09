import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { plainLine } from './plain.ts';

describe('plainLine', () => {
  it('takes the first line with words', () => {
    assert.equal(plainLine('\n\n  Restart done.\nMore here'), 'Restart done.');
    assert.equal(plainLine(''), '');
    assert.equal(plainLine('   \n---\n'), '');
  });

  it('takes the marks off a heading, a list, a quote, a task', () => {
    assert.equal(plainLine('# Report'), 'Report');
    assert.equal(plainLine('- first item'), 'first item');
    assert.equal(plainLine('1) first'), 'first');
    assert.equal(plainLine('> quoted'), 'quoted');
    assert.equal(plainLine('- [x] done'), 'done');
    assert.equal(plainLine('> - [ ] nested'), 'nested');
  });

  it('keeps the words of code, links, emphasis', () => {
    assert.equal(plainLine('Рестарт завершён, исправления `29922e0` теперь в запущенной версии'), 'Рестарт завершён, исправления 29922e0 теперь в запущенной версии');
    assert.equal(plainLine('See [the plan](/files/plan.md) and ![shot](a.png)'), 'See the plan and shot');
    assert.equal(plainLine('**bold**, __also__, *em*, _em_, ~~gone~~'), 'bold, also, em, em, gone');
    assert.equal(plainLine('<https://example.com/x>'), 'https://example.com/x');
    assert.equal(plainLine('a \\* b'), 'a * b');
  });

  it('leaves a lone mark in a sentence alone', () => {
    assert.equal(plainLine('2 * 3 = 6 and snake_case_name'), '2 * 3 = 6 and snake_case_name');
  });

  it('reads through a fence and a table', () => {
    assert.equal(plainLine('```bash\nnpm test\n```'), 'npm test');
    assert.equal(plainLine('| a | b |\n|---|---|\n| 1 | 2 |'), 'a · b');
    assert.equal(plainLine('|---|---|\n| 1 | 2 |'), '1 · 2');
  });
});
