import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { extractEvidenceCandidates } from '../../extensions/voice-context/evidence.js';
import { waitForCaptureStep } from '../../extensions/voice-context/capture-request.js';

const source = (await readFile(new URL('../../extensions/voice-context/popup.js', import.meta.url), 'utf8')).replace(/^import .*\n/gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tab = [{ id: 1, url: 'https://voice.google.com/u/0/messages' }];
const result = text => [{ result: { ok: true, context: {
  text, capturedAt: '2026-11-03T05:00:00Z', captureMode: 'visible-dom', warnings: [], historyComplete: false,
} } }];

function harness(chrome, timeoutMs = 15000) {
  class Element {
    constructor() { this.handlers = {}; this.dataset = {}; this.children = []; this.checked = false; this.value = ''; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
  }
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  element('authorize').checked = true;
  element('mode').value = 'visible-dom';
  vm.runInNewContext(source, {
    document: { getElementById: element, createElement: () => new Element() },
    chrome, URL, Blob, AbortController, setTimeout, clearTimeout, extractEvidenceCandidates,
    captureVisibleVoice() {},
    waitForCaptureStep: (start, options) => waitForCaptureStep(start, { ...options, timeoutMs }),
  });
  return { element, fire: (id, type = 'click') => element(id).handlers[type]() };
}

test('clear releases a capture that is waiting for the tab API, without another read', async () => {
  const pending = deferred();
  let scripts = 0;
  const h = harness({ tabs: { query: () => pending.promise }, scripting: { executeScript: () => { scripts++; return Promise.resolve(result('late')); } } });
  const capture = h.fire('capture');
  try {
    await flush();
    assert.equal(h.element('capture').disabled, true);
    h.fire('clear');
    assert.equal(h.element('capture').disabled, false);
    assert.equal(h.element('context').value, '');
  } finally {
    pending.resolve(tab);
    await capture;
  }
  assert.equal(scripts, 0);
  assert.equal(h.element('context').value, '');
});

test('a cancelled old request cannot release or overwrite a newer in-flight capture', async () => {
  const oldTab = deferred(), newRead = deferred();
  let queries = 0, scripts = 0;
  const h = harness({ tabs: { query: () => ++queries === 1 ? oldTab.promise : Promise.resolve(tab) }, scripting: { executeScript: () => { scripts++; return newRead.promise; } } });
  const first = h.fire('capture');
  let second;
  try {
    await flush();
    h.fire('clear');
    assert.equal(h.element('capture').disabled, false);
    second = h.fire('capture');
    await flush();
    oldTab.resolve(tab);
    await first;
    assert.equal(h.element('capture').disabled, true);
    assert.equal(scripts, 1);
    newRead.resolve(result('Customer name: New fixture'));
    await second;
    assert.equal(h.element('context').value, 'Customer name: New fixture');
    assert.equal(h.element('capture').disabled, false);
  } finally {
    oldTab.resolve(tab);
    newRead.resolve(result('Customer name: New fixture'));
    await first;
    await second;
  }
});

test('a stalled script times out with manual retry available and ignores its late result', async () => {
  const pending = deferred();
  const h = harness({ tabs: { query: () => Promise.resolve(tab) }, scripting: { executeScript: () => pending.promise } }, 5);
  const capture = h.fire('capture');
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(h.element('capture').disabled, false);
    assert.match(h.element('status').textContent, /tardó demasiado/);
    assert.equal(h.element('context').value, '');
  } finally {
    pending.resolve(result('Late fixture must be ignored'));
    await capture;
  }
  assert.equal(h.element('context').value, '');
});

test('withdrawing authorization cancels the wait and reauthorizing does not retry automatically', async () => {
  const pending = deferred();
  let queries = 0, scripts = 0;
  const h = harness({ tabs: { query: () => { queries++; return pending.promise; } }, scripting: { executeScript: () => { scripts++; return Promise.resolve(result('unused')); } } });
  const capture = h.fire('capture');
  await flush();
  h.element('authorize').checked = false;
  h.fire('authorize', 'change');
  await capture;
  assert.equal(h.element('capture').disabled, true);
  assert.equal(h.element('context').value, '');
  h.element('authorize').checked = true;
  h.fire('authorize', 'change');
  assert.equal(h.element('capture').disabled, false);
  pending.resolve(tab);
  await flush();
  assert.equal(queries, 1);
  assert.equal(scripts, 0);
  assert.equal(h.element('context').value, '');
});

test('changing capture mode cancels the pending wait without reading the new mode', async () => {
  const pending = deferred();
  let scripts = 0;
  const h = harness({ tabs: { query: () => pending.promise }, scripting: { executeScript: () => { scripts++; return Promise.resolve(result('unused')); } } });
  const capture = h.fire('capture');
  await flush();
  h.element('mode').value = 'selection';
  h.fire('mode', 'change');
  await capture;
  assert.equal(h.element('capture').disabled, false);
  pending.resolve(tab);
  await flush();
  assert.equal(scripts, 0);
});

test('already-cancelled steps never start and cancelled late rejections are consumed', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  let starts = 0;
  await assert.rejects(waitForCaptureStep(() => { starts++; }, { signal: cancelled.signal }), /cancelada/);
  assert.equal(starts, 0);
  const pending = deferred();
  const controller = new AbortController();
  const step = waitForCaptureStep(() => { starts++; return pending.promise; }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(step, /cancelada/);
  pending.reject(new Error('late fixture failure'));
  await flush();
  assert.equal(starts, 1);
});

test('capture wait handles synchronous errors, success and invalid deadlines', async () => {
  await assert.rejects(waitForCaptureStep(() => { throw new Error('fixture failure'); }), /fixture failure/);
  assert.equal(await waitForCaptureStep(() => Promise.resolve('fixture result')), 'fixture result');
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    let invoked = false;
    await assert.rejects(waitForCaptureStep(() => { invoked = true; }, { timeoutMs }), /configuración/);
    assert.equal(invoked, false);
  }
});
