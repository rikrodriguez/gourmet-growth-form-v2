# Staff session and SQL lead context: read only

Base: Form2 review `cf7bdefd12259f6d0cb8e1eec6671322c32a246a`. This change stays in its existing Growth Dashboard. It does not merge or copy the separate Office/PR13 branch, its editor, TEST_ONLY session tables or proposal API.

The existing `GET /v1/admin/leads/:leadId` keeps `requireStaff`, cookie `gourmet_staff_session_v1`, `PostgresDashboardStore.authenticateStaff` and the existing SQL lead/QA filters. After reading the lead it runs the same staff reader again, withholding the result if the session expired, was revoked or the user was disabled while storage was pending. Both `admin` and `viewer` retain their existing business read access.

The existing lead query now includes its saved `monday_item_id` as text. The response adds `review_context`: actual SQL staff/session IDs, role, expiry, exact lead/item IDs, `can_read: true`, `can_approve_document: false`, `document_status: unlinked`, and null event/proposal IDs. It returns no session token, proof hash, password hash or encrypted phone. Caller parameters never provide the actor, event or proposal. Staff-session metadata is a read projection, not a credential or approval grant.

The existing LeadDetail drawer checks that this context matches the signed-in staff, role, selected lead and SQL item mapping before displaying it. Closing/changing the lead cancels the read and discards late replies; session expiry or a 401 clears the private view. Refresh remounts the lead read. Silent server-side changes are enforced on the next request; no revocation subscription or polling service is introduced.

The drawer shows the exact lead/CRM item and an explicitly disabled document-approval button with no action handler. No approval route or document provider is added. No event or proposal ID is derived from telemetry events, visitor sessions, names, dates or URLs. The schema, roles, grants, login, credentials, existing CRM worker and provider configuration are unchanged.

## Verification

Use only a fresh loopback test database with unchanged migrations, then run `npm test`, `npm run typecheck`, `npm run build`, `npm run dashboard:build`, and `npm run test:dashboard:e2e -- --retries=0`. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select a browser already installed in the same execution environment; CI uses its lockfile-compatible browser.

PostgreSQL tests exercise the actual staff reader, HTTP route, lead query and two distinct lead/item mappings for both roles. They cover unauthenticated/unknown IDs, contradictory request parameters, revocation, expiry and disabled users before and after a deliberately held SQL read. Browser fixtures cover both read roles, contradictory context/actor/approval, late A after B, expiry, revoked reread, and existing analytics/filter/logout regressions on desktop, tablet and mobile. All rows, proofs and roles used in these tests are synthetic and isolated; no commercial accounts or grants are created.

The branch-only `staff-lead-readonly-ci.yml` runs these regressions with ephemeral PostgreSQL and retains only synthetic PNGs for three days. It has repository/ref guards, read-only repository permissions, pinned actions and no deployment, publication, external provider calls or secret consumption. Existing staging publication is push-on-develop/manual; production publication requires a guarded manual/reusable workflow. Neither is invoked by this feature branch. Their files remain unchanged.

## Remaining document integration

The SQL lead UUID and its CRM item are now tied to the existing staff read session. The legacy Calculator/Quotes producer still must supply the authorized mapping to a catering event and an immutable document/version/content. `growth_v2.events.event_id` is telemetry, not a catering-event identity. No such mapping is invented here.

Before document approval can be enabled, an existing applicable approval permission must be identified; reporting `admin/viewer` alone does not provide it. Office integration and any commercial runtime activation remain separate reviewable changes. Payments remains paused. No merge, deployment, messages, hosting access or real customer data is part of this change.
