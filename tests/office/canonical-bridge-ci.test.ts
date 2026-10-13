import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/gourmet-office-recovery-ci.yml', import.meta.url), 'utf8');
const verificationBranches = [
  'codex/canonical-reference-bridge-20261012',
  'codex/gourmet-office-demo-recovery-20261010',
  'feat/gourmet-dashboard-reference-20261013',
  'feat/office-communications-review-20261013',
];

// Read the actual checked-in policy, without evaluating workflow expressions or
// contacting GitHub. Unsupported layouts fail closed for human review.
function topLevelBlock(key: string): string {
  const match = workflow.match(new RegExp(`^${key}:\\n((?:[ \\t].*\\n|\\n)+)`, 'm'));
  assert(match, `Missing ${key} policy`);
  return match[1];
}

describe('approved canonical bridge CI boundaries', () => {
  it('accepts push revisions only from the four explicit verification branches in the intended repository', () => {
    const triggers = topLevelBlock('on');
    assert.deepEqual([...triggers.matchAll(/^  ([\w_]+):/gm)].map(match => match[1]), ['push']);
    const pushBranches = [...triggers.matchAll(/^      - (\S+)$/gm)].map(match => match[1]).sort();
    assert.deepEqual(pushBranches, verificationBranches);
    assert(!triggers.includes('tags:') && !triggers.includes('paths:'), 'Every approved push revision must be verified');

    const condition = workflow.match(/^    if: (.+)$/m)?.[1];
    assert(condition, 'The verification job needs its own repository and branch guard');
    const guarded = condition.match(/^github\.repository == 'rikrodriguez\/gourmet-growth-form-v2' && \(([^()]+)\)$/);
    assert(guarded, 'Repository restriction must apply to every allowed branch');
    const terms = guarded[1].split(' || ');
    const guardedBranches = terms.map(term => {
      const ref = term.match(/^github\.ref == 'refs\/heads\/([^']+)'$/);
      assert(ref, 'Every job branch restriction must be an explicit head reference');
      return ref[1];
    }).sort();
    assert.deepEqual(guardedBranches, verificationBranches);
  });

  it('does not grant write permissions, persist checkout credentials or consume external secrets', () => {
    assert.equal(topLevelBlock('permissions').trim(), 'contents: read');
    assert.equal([...workflow.matchAll(/^\s*permissions:/gm)].length, 1, 'Jobs cannot override the read-only permissions');
    assert.match(workflow, /^          persist-credentials: false$/m);
    assert.doesNotMatch(workflow, /\bsecrets\.|\bgithub\.token\b|^\s*(?:token|environment|environments):/m);
    const actions = [...workflow.matchAll(/^        uses: (\S+)(?: #.*)?$/gm)].map(match => match[1]);
    assert.equal(actions.length, 2);
    for (const action of actions) assert.match(action, /^actions\/(?:checkout|setup-node)@[a-f0-9]{40}$/, 'Actions must remain revision-pinned');
  });

  it('runs the existing checks with isolated development PostgreSQL and a local image build', () => {
    assert.match(workflow, /^      OFFICE_RUNTIME_MODE: development$/m);
    for (const command of [
      'npm run typecheck', 'npm run build', 'npm run office:build',
      'npm run test:operations', 'npm run office:db -- start', 'npm run test:office',
      'npm run test:e2e', 'npm run test:office:e2e', 'npm run test:staging:e2e',
      'npm run test:communications:e2e', 'npm run test:dashboard:e2e',
      'docker build --target runtime --tag gourmet-office-ci:checked .', 'npm run office:db -- stop',
    ]) assert(workflow.split('\n').some(line => line.trim() === command || line.trim() === `run: ${command}`), `Missing check: ${command}`);
    const executableLines = workflow.split('\n').filter(line => /^        run:|^          \S/.test(line));
    assert.doesNotMatch(executableLines.join('\n'), /\b(?:docker\s+(?:push|login)|git\s+push|curl|wget|ssh|scp|rsync|gh|deploy|migrate)\b/i);
    assert.match(workflow, /- name: Stop the isolated test database\n        if: always\(\)\n/);
  });
});
