import assert from 'node:assert/strict';
import { test } from 'node:test';

import '../public/assets/markdown.js';
const { render } = globalThis.LeanMarkdown;

test('renders headings, emphasis, links, lists, and blockquotes safely', () => {
  const html = render([
    '# Title',
    '',
    'This is **important**, *emphasized*, and ~~removed~~.',
    '[Example](https://example.com)',
    '',
    '- one',
    '- two',
    '',
    '> quoted'
  ].join('\n'));

  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>important<\/strong>/);
  assert.match(html, /<em>emphasized<\/em>/);
  assert.match(html, /<del>removed<\/del>/);
  assert.match(html, /<a href="https:\/\/example\.com"/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
});

test('renders fenced code and escapes its contents', () => {
  const html = render('```js\nif (a < b && c > d) { alert("<img src=x onerror=alert(1)>"); }\n```');
  assert.match(html, /data-language="js"/);
  assert.match(html, /if \(a &lt; b &amp;&amp; c &gt; d\)/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('renders tables without swallowing adjacent paragraphs', () => {
  const html = render([
    'Before table:',
    '',
    '| Command | Purpose |',
    '| --- | --- |',
    '| `npm start` | Start LeanLLM |'
  ].join('\n'));

  assert.match(html, /<p>Before table:<\/p>/);
  assert.match(html, /<table>/);
  assert.match(html, /<code>npm start<\/code>/);
});

test('blocks unsafe URLs', () => {
  const html = render('[click](javascript:alert(1))');
  assert.doesNotMatch(html, /href="javascript:/);
});
