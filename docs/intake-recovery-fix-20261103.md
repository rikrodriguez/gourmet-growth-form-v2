# Context intake recovery — 3 November 2026

## Reproduced failures

- A stalled Chrome tab or script request left capture permanently busy. Clearing, changing modes or withdrawing authorization discarded the snapshot but could not release the pending request.
- An out-of-contract labelled value (zero deposit, oversized decimal or more than 2000 characters of customer/event text) became a candidate and caused the entire inspection to throw later in the Monday comparison stage.
- Individually valid candidates with a deposit above the total also made inspection throw, hiding unrelated evidence needed to correct the input.

## Corrections

Capture waits now support cancellation and a 15-second timeout per API stage. A new capture requires a new authorized click. Late settlements are consumed without updating the UI, starting a subsequent read or releasing a newer capture's busy state. Cancellation cannot undo a Chrome read already started.

Extraction now uses the existing reviewed-field limits. Invalid latest observations remain visible with exact quotes and offsets, make the field unresolved, and do not silently restore an earlier value. Incompatible candidate totals/deposits yield a structured review issue while preserving both source values. No reviewed-value, identity, payment or generation gate is relaxed.

## Verification and limits

The stalled-capture and invalid-inspection regressions failed against the previous code. Dependency-free Node tests exercise the actual popup handler source with synthetic DOM/Chrome objects, the asynchronous helper, the inspection CLI and generation rejection. These are not tests of a native extension or real Google Voice account. Browser launch and native extension installation remain blocked in this environment; no restriction was bypassed.

GHL surveys, workflow configuration, commercial records, prices, payment providers and messages are untouched. This improves the offline context intake; it does not resolve or validate the separate real GHL survey submission failure.
