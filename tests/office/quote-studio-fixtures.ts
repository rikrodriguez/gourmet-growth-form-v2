/** Characterization inputs only. The parent supplied an excerpt referring to
 * thread 01a14a22-9fcb-70de-8c3b-9b17a516d0db: load {ok,id,revision,state}, a
 * shared template projectId, and an observed payload size of 579815 bytes.
 * That thread was not retrieved here. No real payload, IDs or export bytes
 * are included, and this minimal state does not describe the producer schema. */
export const REPORTED_QUOTE_STUDIO_PAYLOAD_BYTES = 579_815;
export const SYNTHETIC_TEMPLATE_PROJECT_ID = 'synthetic-shared-template';
export type SyntheticQuoteStudioLoad = {
  ok: boolean; id: string; revision: number;
  state: { projectId: string; syntheticPadding: string };
};
export function syntheticQuoteStudioLoad(patch: Partial<Pick<SyntheticQuoteStudioLoad, 'ok' | 'id' | 'revision'>> = {}): SyntheticQuoteStudioLoad {
  return { ok: true, id: 'synthetic-load-a', revision: 17, ...patch,
    state: { projectId: SYNTHETIC_TEMPLATE_PROJECT_ID, syntheticPadding: 'synthetic-state-only' } };
}
/** Deterministic UTF-8 size vector, not an export or a reconstruction of the
 * observed payload. Serializing this synthetic state is deliberately proposed
 * as document content only to exercise the existing document-size boundary. */
export function syntheticStudioStateText(bytes: number): string {
  const state = { projectId: SYNTHETIC_TEMPLATE_PROJECT_ID, syntheticPadding: '' };
  const paddingBytes = bytes - Buffer.byteLength(JSON.stringify(state), 'utf8');
  if (!Number.isSafeInteger(paddingBytes) || paddingBytes < 0) throw new Error('Invalid synthetic size vector');
  state.syntheticPadding = 'é'.repeat(Math.floor(paddingBytes / 2)) + 'x'.repeat(paddingBytes % 2);
  return JSON.stringify(state);
}
