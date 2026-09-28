/**
 * The Markdown renderer the Page uses, run as the bytes a browser is served.
 *
 * `web/markdown.js` is read off disk and run in a fresh context, exactly as a
 * browser would run it, and nothing of `src/` is imported. What matters is
 * what a person sees: a body reads formatted, and text never becomes markup.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));

async function renderer(): Promise<(text: string) => string> {
  const code = await readFile(join(REPOSITORY, 'web', 'markdown.js'), 'utf8');
  const context = createContext({});
  runInContext(code, context);
  return context['renderMarkdown'] as (text: string) => string;
}

test('a body reads formatted: emphasis, code, lists and links', async () => {
  const render = await renderer();

  const html = render(
    'Some **bold**, *soft* and `code`.\n\n- one\n- two\n\n1. first\n\n[the spec](https://example.com/1)',
  );

  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>soft<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><\/ol>/);
  assert.match(html, /<a href="https:\/\/example.com\/1"[^>]*>the spec<\/a>/);
});

test('headings, quotes and fenced code read as themselves', async () => {
  const render = await renderer();

  const html = render('## Done\n\n> said in the Meeting\n\n```\nconst a = 1 < 2;\n```');

  assert.match(html, /<h2>Done<\/h2>/);
  assert.match(html, /<blockquote><p>said in the Meeting<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>const a = 1 &lt; 2;<\/code><\/pre>/);
});

test('HTML in a body shows as text and never becomes markup', async () => {
  const render = await renderer();

  const html = render('<script>alert(1)</script> and <img src=x onerror=alert(1)>');

  assert.ok(!html.includes('<script'), html);
  assert.ok(!html.includes('<img'), html);
  assert.match(html, /&lt;script&gt;/);
});

test('a link to a script address is kept as text, not as a link', async () => {
  const render = await renderer();

  const html = render('[click](javascript:alert(1)) and [data](data:text/html,x)');

  assert.ok(!html.includes('href'), html);
});

test('a quote in a link text cannot break out of the address', async () => {
  const render = await renderer();

  const html = render('[x](https://a.example/"onmouseover="alert(1))');

  assert.ok(!/href="[^"]*"onmouseover/.test(html), html);
});

test('an indented list item nests inside the item above it', async () => {
  const render = await renderer();

  const html = render('* Libs de UI:\n   * https://spell.sh/\n   * two\n* back out\n\t- tabbed in');

  assert.match(
    html,
    /^<ul><li>Libs de UI:<ul><li><a [^>]*>spell\.sh<\/a><\/li><li>two<\/li><\/ul><\/li>/,
  );
  assert.match(html, /<li>back out<ul><li>tabbed in<\/li><\/ul><\/li><\/ul>$/);
});

test('a numbered list may nest inside a bulleted one, and the other way round', async () => {
  const render = await renderer();

  const html = render('- steps\n  1. first\n  2. second\n- done');

  assert.equal(html, '<ul><li>steps<ol><li>first</li><li>second</li></ol></li><li>done</li></ul>');
});

test('a bare address reads short, and still goes to the whole address', async () => {
  const render = await renderer();

  const html = render('See https://www.cult-ui.com/ and https://github.com/a/b/pull/1');

  assert.match(html, /<a href="https:\/\/www\.cult-ui\.com\/"[^>]*>cult-ui\.com<\/a>/);
  assert.match(html, /<a href="https:\/\/github\.com\/a\/b\/pull\/1"[^>]*>github\.com\/a\/b\/pull\/1<\/a>/);
});

test('a table reads as a table, with its alignment and its checkboxes', async () => {
  const render = await renderer();

  const html = render(
    'Before.\n| Name | Done | Size |\n| --- | :---: | ---: |\n| **one** | [ ] | 1 |\n| `a|b` | [x] | 22 |',
  );

  assert.match(html, /<p>Before\.<\/p><div class="table"><table>/);
  assert.match(html, /<thead><tr><th>Name<\/th><th class="center">Done<\/th><th class="right">Size<\/th><\/tr><\/thead>/);
  assert.match(html, /<td><strong>one<\/strong><\/td><td class="center"><input type="checkbox" disabled><\/td>/);
  assert.match(html, /<td><code>a\|b<\/code><\/td><td class="center"><input type="checkbox" disabled checked><\/td><td class="right">22<\/td>/);
});

test('a row with too few cells is filled, and an escaped pipe is text', async () => {
  const render = await renderer();

  const html = render('a | b\n--- | ---\nx \\| y\n');

  assert.match(html, /<tr><td>x \| y<\/td><td><\/td><\/tr>/);
});

test('a line with a pipe is no table without a delimiter row under it', async () => {
  const render = await renderer();

  const html = render('this | that\nand more');

  assert.doesNotMatch(html, /<table>/);
  assert.match(html, /<p>this \| that<br>and more<\/p>/);
});

test('HTML in a table cell shows as text and never becomes markup', async () => {
  const render = await renderer();

  const html = render('| a |\n| - |\n| <img src=x onerror=alert(1)> |');

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a text cut into blocks joins back into the same text, and renders the same', async () => {
  const code = await readFile(join(REPOSITORY, 'web', 'markdown.js'), 'utf8');
  const context = createContext({});
  runInContext(code, context);
  const render = context['renderMarkdown'] as (text: string) => string;
  const cut = context['markdownBlocks'] as (
    text: string,
  ) => { source: string; html: string; after: string }[];
  const text =
    'Tenho **x**.\nLinha 2\n\n| a | b |\n| - | - |\n| 1 | [ ] |\n\n\n## H\n- a\n  - b\n' +
    '```\ncode\n\nmore\n```\n> q\n\ntail\n';

  const blocks = cut(text);

  assert.deepEqual(
    Array.from(blocks, (block) => block.source),
    ['Tenho **x**.\nLinha 2', '| a | b |\n| - | - |\n| 1 | [ ] |', '## H', '- a\n  - b',
      '```\ncode\n\nmore\n```', '> q', 'tail'],
  );
  assert.equal(blocks.map((block) => block.source + block.after).join(''), text);
  assert.equal(blocks.map((block) => block.html).join(''), render(text));
});
