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
});
