# Multi-keyword funnel architecture

## Active architecture

`src/variants/registry.ts` is the single route registry. A registered variant supplies presentation copy, visual asset metadata, progress wording, CTA labels, thank-you policy, and analytics/CRM metadata to the shared `VariantFunnel` engine in `src/App.tsx`.

The active registry contains `/form2/bbq/`, `/form2/funeral/`, `/form2/corporate/`, `/form2/catering-near-me/`, and `/form2/taco/`. Unknown routes fail closed to the foundation screen; they never inherit BBQ copy accidentally. The shared funnel retains the existing lead API, telemetry transport, consent handling, dashboard storage, and Monday outbox.

Variant state is namespaced by slug. Anonymous visitor/session identity stays shared. To remain byte-for-byte compatible with the deployed backend contract, the registered variant uses one stable `intentCluster` as its persisted variant/service-category key; the landing route, approved UTM/click IDs, and origin-only referrer continue through the existing attribution object. The richer `variantSlug` and `serviceCategory` values remain typed config metadata for analytics/CRM adapters and are not added as new client payload fields. The server derives its intent allowlist from the same registry, so registering a future config extends the allowed value without changing the request shape or accepting arbitrary client-provided categories.

## Thank-you decision and transition

Direct reuse of `https://gourmet-corporation.com/thank-you/` is blocked. Read-only HTTP inspection on 2026-09-28 returned `200` and the title `Chef Felipe | Boutique Culinary Architecture & Premium Catering`; the body is a complete acquisition landing page with fresh proposal CTAs/forms, not a lead confirmation page. The response body was byte-identical for the bare URL, the `www` hostname, and a request with `variant`, `lead_source`, `utm_source`, and `utm_campaign`, so the page does not currently consume the proposed context.

M4A.1 adds the reusable V2 confirmation route at `/form2/thank-you/`; it contains no form or acquisition CTA. The BBQ config redirects there only when the first-party API is configured and the progressive lead has been persisted. The shared engine enforces this sequence:

1. validate the name step;
2. persist the final lead update successfully;
3. require a persisted lead ID and configured first-party API;
4. save a minimal session-only confirmation snapshot without phone, ZIP, lead ID, visitor ID, or session ID;
5. emit the complete step and completion measurement;
6. navigate with `window.location.assign`.

The confirmation URL contains no query data. The session snapshot may contain the first name and non-contact request summary under the existing current-session lifetime so the page can personalize the acknowledgement. If persistence fails, the user remains in the funnel with retry behavior.

When the API is not configured, local development retains the internal completion state so the funnel remains testable without simulating a successful backend write.

## Active variant policy

BBQ, Taco, and Catering Near Me retain all seven visible question screens. Funeral and Corporate use six: the canonical `event_type` machine ID remains reserved as step 5, but its semantic value is a typed configuration prefill and its visible screen is omitted. Progress therefore says “Step N of 6” for those variants while telemetry stays canonical.

The BBQ hero remains the approved first-party asset. Funeral, Corporate, Catering Near Me, and Taco intentionally use configuration-specific gradient fallbacks with `hero.status = "provisional"` until message-matched Gourmet-owned assets and visual approval are supplied. No exit-intent or social-proof component is active on any route.

For every registered variant, the shared confirmation policy retains the variant slug in its session-only completion snapshot and resolves the corresponding safe configuration at `/form2/thank-you/`.

No separate app, backend endpoint, database, telemetry schema, or Monday worker is required. New CRM columns remain a separately governed board change; the existing pipeline keeps its current columns and receives the variant context through the lead/session attribution model.
