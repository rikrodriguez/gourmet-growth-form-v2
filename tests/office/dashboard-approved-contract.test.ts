import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
const luminance = (hex: string) => { const [r, g, b] = rgb(hex); return r * .2126 + g * .7152 + b * .0722; };
const contrast = (a: string, b: string) => { const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y); return (light + .05) / (dark + .05); };

test('the owner-approved complete light Dashboard source is frozen independently of product changes', () => {
  const manifest = JSON.parse(read('docs/design-approved/gourmet-dashboard-20261013.json'));
  assert.deepEqual(manifest.viewport, { width: 1440, height: 960 });
  assert.equal(manifest.synthetic, true);
  for (const [file, hash] of Object.entries(manifest.files)) {
    const actual = createHash('sha256').update(readFileSync(new URL(`docs/design-approved/${file}`, root))).digest('hex');
    assert.equal(actual, hash);
  }
  assert.equal(manifest.tokens.canvas, '#f2f3f0'); assert.equal(manifest.tokens.surface, '#ffffff');
});

test('approved layout small text keeps readable contrast and no declared font below 12 pixels', () => {
  const css = read('src/office/dashboard/approved-dashboard.css');
  const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
  assert(sizes.length > 10); assert(sizes.every(size => size >= 12));
  // Declared palette checks, not a claim of computed browser/a11y QA.
  const pairs = [
    ['#191b1c', '#ffffff'], ['#62645f', '#f7f7f4'], ['#62665e', '#ffffff'],
    ['#64665f', '#eeeee6'], ['#686b63', '#ffffff'], ['#62675d', '#ffffff'],
    ['#386844', '#e8f0e9'], ['#697064', '#ffffff'], ['#64695f', '#f2f3f0'],
    ['#ffffff', '#18191b'], ['#ffffff', '#cc254e'], ['#48735e', '#f2f3f0'],
  ];
  for (const [foreground, background] of pairs) assert(contrast(foreground, background) >= 4.5, `${foreground} / ${background}`);
});

test('refresh and withdrawal explicitly replace the ephemeral event generation even for immediate reads', () => {
  const source = read('src/office/DashboardPage.tsx');
  assert.match(source, /<EventWorkspace key=\{eventSessionEpoch\}/);
  assert.equal((source.match(/setEventSessionEpoch\(epoch => epoch \+ 1\)/g) ?? []).length, 2);
  assert.match(source, /focusHeadingOnSectionChange=\{focusHeadingOnSectionChange\}/);
  assert.match(source, /onTabChange=\{tab => \{ setFocusHeadingOnSectionChange\(false\)/);
});

test('local approved modules do not add provider, storage, HTML execution or session initialization authority', () => {
  const paths = ['src/office/dashboard/ApprovedDashboardLayout.tsx', 'src/office/dashboard/event-workflow.ts', 'src/office/dashboard/EventWorkspace.tsx'];
  for (const path of paths) {
    const source = read(path);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|localStorage|sessionStorage|fetch\(|startSession\(|XMLHttpRequest|WebSocket|window\.open|<iframe|<object/);
  }
  assert.doesNotMatch(read('src/office/dashboard/EventWorkspace.tsx'), /target="_blank"/);
});
