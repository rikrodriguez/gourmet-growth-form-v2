import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const css = readFileSync(new URL('../../src/office/dashboard.css', import.meta.url), 'utf8');
function luminance(hex: string) {
  const rgb = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function ratio(a: string, b: string) { const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (light + .05) / (dark + .05); }
function explicitColor(selector: string) {
  let color: string | undefined;
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].trim() !== selector) continue;
    const value = match[2].match(/(?:^|;)\s*color:\s*(#[a-f0-9]{6})(?:;|$)/i)?.[1]; if (value) color = value;
  }
  assert(color, `Expected a measured explicit color for ${selector}`); return color;
}

test('dashboard small-text palettes meet WCAG AA contrast on their light and selected card surfaces', () => {
  // Declared palette regression, not a substitute for computed browser/a11y QA.
  const cases: [string, string][] = [
    ['.gd-metric-coverage', '#e7eddf'], ['.gd-metric-coverage', '#fffef9'],
    ['.gd-ads-stats small', '#f0efe5'], ['.gd-revenue-message p', '#fffef9'],
    ['.gd-stage-step', '#eceee5'], ['.gd-stage-step>span', '#eceee5'],
    ['.gd-opportunity dt', '#fffef8'], ['.gd-opportunity footer>small', '#fffef8'],
    ['.gd-list-caption', '#fafaf3'], ['.gd-conversation-state', '#eaf0df'],
    ['.gd-conversation-date', '#eaf0df'], ['.gd-detail-sender time', '#fffef9'],
    ['.gd-detail-footer>span', '#fffef9'], ['.gd-footer', '#f4f3ed'],
    ['.gd-nav-group', '#fbfaf5'], ['.gd-pending-nav', '#fbfaf5'], ['.gd-pending-nav small', '#fbfaf5'],
    ['.gd-period', '#f4f3ed'], ['.gd-evidence', '#eef0e6'], ['.gd-channel-filters button', '#fffef8'], ['.gd-channel-filters button[aria-pressed=true]', '#274b3a'], ['.gd-activity li time', '#fffef9'], ['.gd-activity-note', '#fffef9'],
    ['.gd-channel-label', '#f2f2e9'], ['.gd-stage-empty', '#eceee5'], ['.gd-source-card dt', '#fffef9'],
  ];
  assert.match(css, /\.gd-filter-count\{[^}]*opacity:1/);
  assert.doesNotMatch(css, /\.gd-filter-count\{[^}]*opacity:\s*0?\./);
  for (const [selector, background] of cases) { const color = explicitColor(`.gourmet-dashboard ${selector}`); assert.ok(ratio(color, background) >= 4.5, `${selector}: ${color} on ${background} is ${ratio(color, background).toFixed(2)}:1`); }
});
