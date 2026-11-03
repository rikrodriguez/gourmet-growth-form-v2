# Offline preview validation corrections — 3 November 2026

## Reproduced defects

The adapter checked a line item's unit amount but accepted quantities such as 2, zero, negative values and fractions. The corrected guard permits the existing omitted quantity or an explicit single unit, so this multiplier cannot alter the reviewed deposit. It does not claim to implement the complete provider schema.

The preview inserted its Content Security Policy and demo warning by replacing the first head/body markers. Markers inside an HTML comment received both additions, leaving the actual page without either protection. The output now starts with a trusted document wrapper containing the policy and warning before any template bytes are parsed.

HTML also permits slash-separated attributes. These and duplicate target attributes bypassed the previous whitespace-only removal. Target removal now handles both separators and responsive/form targets. It replaces removed attributes with a space rather than concatenating surrounding tokens, and rechecks the resulting markup for disallowed active content.

## Verification

- Four regression tests failed before their fixes and pass afterward. They cover quantity values, comment-disguised markers, slash-separated/duplicate attributes and token-boundary preservation.
- 50 offline Node contracts pass, including the previous conversation, review, Monday comparison and evidence tests. Module syntax checks and Vite build pass.
- An independent static HTML parse reproduced the original missing-policy defect. Browser launch remains blocked by the environment's socket restriction; no browser policy was weakened and no browser/network verification is claimed.
- The private external generator adapter is unavailable in this workspace and was not rerun. The public synthetic process tests validate only the adapter protocol.

All changes remain offline and fixture-only. They do not activate GHL workflows, submit intake data, publish pages, change commercial prices or payment records, call a payment provider, or send communications. The existing Hostinger publication workflow is unchanged and is not invoked by this draft branch.
