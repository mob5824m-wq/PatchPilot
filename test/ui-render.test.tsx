import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToString } from 'react-dom/server';

/**
 * Renders the whole UI shell once with React's server renderer.
 *
 * No DOM is needed for the initial pass, and it catches the class of mistake
 * that TypeScript cannot see in JSX — a bad tree, a missing export, a hook used
 * outside a component — without pulling a browser into the test suite.
 */
test('the app shell renders', async () => {
  const { App } = await import('../src/web/App.tsx');
  const html = renderToString(<App />);
  assert.ok(html.includes('PatchPilot'));
  assert.ok(html.includes('Apps'));
  assert.ok(html.includes('Library'));
  assert.ok(html.includes('Sources'));
  assert.ok(html.includes('Bundles'));

  // The mark is inline SVG, so the shell carries the seal rather than a link
  // that can 404. Its geometry is checked against brand/logo.svg in
  // android-contract.test.ts.
  assert.ok(html.includes('class="brand-mark"'), 'the header mark is missing');
  assert.ok(html.includes('M16.00 5.97'), 'the header mark is not the PatchPilot seal');
  assert.ok(html.includes('aria-label="PatchPilot"'), 'the mark should be labelled for screen readers');
});
