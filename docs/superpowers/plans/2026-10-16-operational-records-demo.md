# Operational records DEMO implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Execution is native in the selected workspace; no delegation is required.

**Goal:** Complete one persisted synthetic reception → milestones → incident → resolution → rehearsal closure within Office.

**Architecture:** Add an optional case-owned operational journal to the existing Office aggregate, with typed operations on the existing commands route. Bind every revision to the server-owned Supply event and current dependencies; render it within the existing Logistics and Quality workspace. Closure is an explicit domain decision, never an email approval.

**Tech Stack:** Existing TypeScript/React/Fastify/PostgreSQL and Node/Playwright suites.

**Spec:** User-approved operational proposal; Gourmet OS design v1 §§4–6,7–9 and implementation plan v2 T5/T6, recovered from Library. Current inventory and PR10 `bf41d9ec071bf708dd48b0d1cf11e4c8f2bd9c62` define what is already present.

## Global constraints

- DEMO only; no real sources, accounts, messages, providers, credentials, permissions, merge or deployment.
- No Payments or financial closure changes; `readyForExecution` is unchanged.
- Missing policy blocks closure. A selectable immutable fixture policy permits only a clearly labelled rehearsal using active internal DEMO assignment, approved synthetic procurement and evidenced milestones.
- No dietary/business minima, real signers or SLA are inferred. Quality message drafts never create incidents.
- Preserve legacy aggregates, exact IDs/revisions, source content/hash, history and durable command receipts. No new harness, endpoint or worker.

## Review focus

Cross-case identity; dependency changes after confirmation; stale closure racing an incident; lost responses/restarts; missing or reference-only evidence. Each is covered below.

### Task 1: Case-owned operational domain

Files: create `src/office/operational-contracts.ts`, `src/office/backend/operational-workflow.ts`; modify contracts/state/commands/session/adapter; extend `tests/office/supply-workflow.test.ts` and `tests/office/supply-postgres.test.ts`.

- [ ] Add failing tests through existing commands and serialized/PostgreSQL stores for the complete rehearsal and missing-policy gate.
- [ ] Implement `projectOperationalWorkflow(state, caseId, atMs)` and `applyOperationalOperation(state, command, atMs)` with an immutable bounded journal. Operations carry event ID, expected revision and dependency hash; source fixtures are case-owned. Closure additionally carries the exact review hash.
- [ ] Test partial/reference-only receipts; strict inputs; wrong case/event/function; viewers, expired sessions and revoked scopes; immutable hashes; stale menu/assignment/evidence; idempotent retries and concurrent closure/incident after pool restart. Legacy state is not reseeded or rewritten.

### Task 2: Existing workspace and recovery

Files: create `src/office/OperationalWorkflowSection.tsx`; modify OfficeApp and the existing supply browser suite.

- [ ] Add failing browser assertions to the existing persisted source-to-assignment/procurement flow.
- [ ] Render policy, reception and milestones in Logistics, incidents/resolution/closure in Quality. Use the existing submit/pending-intent handling. Show dependencies, source, content/hash, actor, revision, blockers and history.
- [ ] Verify reload and uncertain-response retry in desktop/mobile, and that a generic Quality draft has no operational effect. Save synthetic screenshots in the existing CI artifact directory.

### Task 3: Verification and draft publication

- [ ] Document implemented scope and outstanding business decisions separately.
- [ ] Run typecheck, both builds, operations and full Office suites; run the existing supply browser suite. Keep all existing CI regressions.
- [ ] Add only this verification branch to the existing read-only workflow and its policy test. Publish branch and draft PR based on PR10; inspect terminal CI for the exact SHA. No deploy workflow is changed or dispatched.
