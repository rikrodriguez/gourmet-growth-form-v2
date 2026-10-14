import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Validate the actual Docker build output, not an unrestricted host build.
export function checkDemoPreviewAssets(root = process.cwd()) {
  const assets = resolve(root, 'dist-office/assets');
  const names = readdirSync(assets);
  const previews = names.filter(name => /^DEMO-EVT-042-propuesta-v2-page-1-[A-Za-z0-9_-]+\.png$/.test(name));
  assert.equal(previews.length, 1, 'The built DEMO preview must exist exactly once');
  const bytes = readFileSync(resolve(assets, previews[0]));
  assert.equal(bytes.length, 178239, 'The built DEMO preview must retain its exact bytes');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '76aff590db6ca01d91a1053f32612a6f9d6678dfa52ba8e814500336b9d885a0', 'The built DEMO preview must match the reviewed source');
  const scripts = names.filter(name => name.endsWith('.js')).map(name => readFileSync(resolve(assets, name), 'utf8'));
  assert(scripts.some(script => script.includes(`/assets/${previews[0]}`)), 'The built JavaScript must reference the emitted preview');
  console.log('PASS: Docker build includes the exact reviewed DEMO preview and its bundled reference.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkDemoPreviewAssets();
