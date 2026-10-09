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
    assert.equal(plainLine('## Report ##  '), 'Report');
    assert.equal(plainLine('- first item'), 'first item');
    assert.equal(plainLine('1) first'), 'first');
    assert.equal(plainLine('> quoted'), 'quoted');
    assert.equal(plainLine('- [x] done'), 'done');
    assert.equal(plainLine('> - [ ] nested'), 'nested');
  });

  it('keeps the words of code, links, emphasis', () => {
    assert.equal(plainLine('Рестарт завершён, исправления `29922e0` теперь в запущенной версии'), 'Рестарт завершён, исправления 29922e0 теперь в запущенной версии');
    assert.equal(plainLine('See [the plan](/files/plan.md) and ![shot](a.png)'), 'See the plan and shot');
    assert.equal(plainLine('See [the plan][1] and ![shot][2]'), 'See the plan and shot');
    assert.equal(plainLine('**bold**, __also__, *em*, _em_, ~~gone~~, *курсив*'), 'bold, also, em, em, gone, курсив');
    assert.equal(plainLine('**[text](u)** and [`code`](u)'), 'text and code');
    assert.equal(plainLine('<https://example.com/x>'), 'https://example.com/x');
    assert.equal(plainLine('a \\* b'), 'a * b');
  });

  it('keeps a link whose destination has parentheses or a title', () => {
    assert.equal(plainLine('See [doc](https://example.com/a_(b)) now'), 'See doc now');
    assert.equal(plainLine('[**spec**](https://example.com "the ) title")'), 'spec');
    assert.equal(plainLine('[a](b.md (paren title)) and [b](<x y.md> "t")'), 'a and b');
  });

  it('keeps the code of a code span, a fence, an indented block as it is', () => {
    assert.equal(plainLine('`foo__bar__baz`'), 'foo__bar__baz');
    assert.equal(plainLine('`a || b` or `*x*`'), 'a || b or *x*');
    assert.equal(plainLine('`` a`b `` c'), 'a`b c');
    assert.equal(plainLine('```js\nconst name = "__init__";\n```'), 'const name = "__init__";');
    assert.equal(plainLine('```sh\ncat file | sort\n```\nAfter'), 'cat file | sort');
    assert.equal(plainLine('```\n\n```\nAfter the empty fence'), 'After the empty fence');
    assert.equal(plainLine('    indented *code*'), 'indented *code*');
  });

  it('keeps an escaped mark, an identifier, a URL as they are', () => {
    assert.equal(plainLine('\\*literal\\*'), '*literal*');
    assert.equal(plainLine('a__b__c and __init__'), 'a__b__c and init');
    assert.equal(plainLine('https://example.com/_foo_/x'), 'https://example.com/_foo_/x');
    assert.equal(plainLine('\\`not code`'), '`not code`');
  });

  it('leaves a lone mark in a sentence alone', () => {
    assert.equal(plainLine('2 * 3 = 6 and snake_case_name'), '2 * 3 = 6 and snake_case_name');
    assert.equal(plainLine('`unclosed code'), '`unclosed code');
  });

  it('reads a table by its cells and a pipe elsewhere as a pipe', () => {
    assert.equal(plainLine('| a | b |\n|---|---|\n| 1 | 2 |'), 'a · b');
    assert.equal(plainLine('|---|---|\n| 1 | 2 |'), '1 · 2');
    assert.equal(plainLine('| `a|b` | c \\| d |\n|---|---|'), 'a|b · c | d');
    assert.equal(plainLine('Status: A | B'), 'Status: A | B');
    assert.equal(plainLine('- item | pipe\n\n| h |\n|---|'), 'item | pipe');
    assert.equal(plainLine('> quote | x'), 'quote | x');
  });
});
