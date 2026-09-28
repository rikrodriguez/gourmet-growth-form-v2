# Multi-keyword funnel architecture

## Active architecture

`src/variants/registry.ts` is the single route registry. A registered variant supplies presentation copy, visual asset metadata, progress wording, CTA labels, thank-you policy, and analytics/CRM metadata to the shared `VariantFunnel` engine in `src/App.tsx`.

Only `/form2/bbq/` is registered. Unknown or planned routes fail closed to the foundation screen; they never inherit BBQ copy accidentally. The shared funnel retains the existing step order, lead API, telemetry transport, consent handling, dashboard storage, and Monday outbox.

Variant state is namespaced by slug. Anonymous visitor/session identity stays shared. To remain byte-for-byte compatible with the deployed backend contract, the registered variant uses one stable `intentCluster` as its persisted variant/service-category key; the landing route, approved UTM/click IDs, and origin-only referrer continue through the existing attribution object. The richer `variantSlug` and `serviceCategory` values remain typed config metadata for analytics/CRM adapters and are not added as new client payload fields. The server derives its intent allowlist from the same registry, so registering a future config extends the allowed value without changing the request shape or accepting arbitrary client-provided categories.

## Thank-you decision

Direct reuse of `https://gourmet-corporation.com/thank-you/` is blocked. Read-only HTTP inspection on 2026-09-28 returned `200` and the title `Chef Felipe | Boutique Culinary Architecture & Premium Catering`; the body is a complete acquisition landing page with fresh proposal CTAs/forms, not a lead confirmation page. The response body was byte-identical for the bare URL, the `www` hostname, and a request with `variant`, `lead_source`, `utm_source`, and `utm_campaign`, so the page does not currently consume the proposed context.

The BBQ config therefore keeps the existing internal completion state and performs no external redirect. The shared engine already enforces the future redirect sequence:

1. validate the name step;
2. persist the final lead update successfully;
3. emit completion measurement;
4. require a persisted lead ID and configured first-party API;
5. build an allowlisted URL containing only `variant`, `lead_source`, `utm_source`, and `utm_campaign`;
6. navigate with `window.location.assign`.

No phone, name, ZIP, email, visitor ID, session ID, raw query string, or full answer object is eligible for the redirect URL. If persistence fails, the user remains in the funnel with retry behavior.

Activation requires either a corrected existing confirmation page or an exact approved reference for a V2-owned replica. No approximate replica is permitted.

## Future variant rollout

For each of `funeral`, `corporate`, `catering-near-me`, and `taco`:

1. approve message-matched copy, image assets, claims, and mobile Golden Masters;
2. add one typed config entry and asset manifest records;
3. register exactly one route after route-level content, accessibility, and responsive tests pass;
4. verify the existing lead, telemetry, consent, dashboard, and Monday pipeline with that config's metadata;
5. activate the shared external thank-you policy only after its destination passes confirmation-page and tracking QA.

No separate app, backend endpoint, database, telemetry schema, or Monday worker is required. New CRM columns remain a separately governed board change; the existing pipeline keeps its current columns and receives the variant context through the lead/session attribution model.
