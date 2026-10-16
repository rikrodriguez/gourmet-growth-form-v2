import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

it('keeps staff-lead verification on its explicit branch with read permissions and synthetic local services', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/staff-lead-readonly-ci.yml', import.meta.url), 'utf8');
  const trigger = workflow.match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1];
  assert.equal(trigger?.trim(), 'push:\n    branches:\n      - feat/staff-lead-readonly-20261016');
  assert.match(workflow, /^    if: github\.repository == 'rikrodriguez\/gourmet-growth-form-v2' && github\.ref == 'refs\/heads\/feat\/staff-lead-readonly-20261016'$/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.equal([...workflow.matchAll(/^\s*permissions:/gm)].length, 1);
  assert.match(workflow, /^          persist-credentials: false$/m);
  assert.doesNotMatch(workflow, /\bsecrets\.|\bgithub\.token\b|^\s*environment:/m);
  assert.doesNotMatch(workflow, /\b(?:git push|docker push|workflow_call|workflow_dispatch|test:e2e:staging|curl|wget|ssh|scp|rsync)\b/);
  for (const action of workflow.matchAll(/^        uses: (\S+)/gm)) assert.match(action[1], /^actions\/(?:checkout|setup-node|upload-artifact)@[a-f0-9]{40}$/);
  for (const command of ['npm test', 'npm run typecheck', 'npm run build', 'npm run dashboard:build', 'npm run test:dashboard:e2e -- --retries=0']) assert(workflow.includes(command));
  assert.match(workflow, /path: test-results\/staff-lead-visual\/\*\.png\n          retention-days: 3/);
});
