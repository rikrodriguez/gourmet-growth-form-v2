import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkDemoPreviewAssets } from '../../src/office/build/check-demo-assets.mjs';

const preview = 'DEMO-EVT-042-propuesta-v2-page-1-TEST.png';
const source = new URL('../../src/office/assets/demo/DEMO-EVT-042-propuesta-v2-page-1.png', import.meta.url);
function fixture(run: (root: string, assets: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'gourmet-demo-assets-'));
  const assets = join(root, 'dist-office/assets'); mkdirSync(assets, { recursive: true });
  try { run(root, assets); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('Docker permits only the reviewed DEMO image and verifies its built output', () => {
  const ignore = readFileSync(new URL('../../.dockerignore', import.meta.url), 'utf8');
  assert(ignore.includes('**/*.png'));
  assert(ignore.includes('!src/office/assets/demo/DEMO-EVT-042-propuesta-v2-page-1.png'));
  assert(!ignore.includes('!src/office/assets/demo/**'));
  const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  assert(dockerfile.includes('RUN npm run office:build && node src/office/build/check-demo-assets.mjs'));
});
test('asset guard accepts the exact preview linked by the compiled JavaScript', () => fixture((root, assets) => {
  copyFileSync(source, join(assets, preview)); writeFileSync(join(assets, 'index.js'), `const image="/assets/${preview}";`);
  checkDemoPreviewAssets(root);
}));
test('asset guard rejects missing, corrupted, duplicate and unreferenced preview output', () => {
  for (const failure of ['missing', 'corrupt', 'duplicate', 'unreferenced']) fixture((root, assets) => {
    if (failure !== 'missing') copyFileSync(source, join(assets, preview));
    if (failure === 'corrupt') writeFileSync(join(assets, preview), Buffer.alloc(178239));
    if (failure === 'duplicate') copyFileSync(source, join(assets, 'DEMO-EVT-042-propuesta-v2-page-1-OTHER.png'));
    writeFileSync(join(assets, 'index.js'), failure === 'unreferenced' ? 'const image="/assets/missing.png";' : `const image="/assets/${preview}";`);
    assert.throws(() => checkDemoPreviewAssets(root));
  });
});
