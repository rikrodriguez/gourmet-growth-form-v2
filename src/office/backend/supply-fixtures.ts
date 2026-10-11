import type { SupplyCandidateAnnouncement, SupplyDigestFixture, SupplyMenuFixture, SupplyPurchaseOptionFixture, SupplyTermsFixture, SyntheticSupplyEvent } from '../supply-contracts';
import type { DemoCaseId } from './state';
import { currentTime, evidence } from './state';

export type SupplyFixtures = {
  event: SyntheticSupplyEvent; digestFixtures: SupplyDigestFixture[]; termsFixtures: SupplyTermsFixture[];
  menuFixtures: SupplyMenuFixture[]; optionFixtures: SupplyPurchaseOptionFixture[];
};

// These IDs identify synthetic people globally across cases. Case-owned records
// retain their own revisions; overlapping assignments use this shared identity.
export const SYNTHETIC_CANDIDATE_IDS = ['candidate-demo-alba', 'candidate-demo-beto', 'candidate-demo-cora', 'candidate-demo-dario'] as const;

export function getSupplyFixtures(caseId: DemoCaseId, initializedAtMs: number): SupplyFixtures {
  currentTime(() => initializedAtMs);
  const iso = (offsetMs: number) => new Date(currentTime(() => initializedAtMs + offsetMs)).toISOString();
  const proof = (reference: string) => evidence(caseId, reference, initializedAtMs, 'fixture:office-demo');
  const event: SyntheticSupplyEvent = {
    id: `supply-event-${caseId}`, caseId, revision: 1, city: 'Ciudad DEMO', coverage: 'Zona DEMO Centro',
    window: { startAt: iso(7 * 86_400_000), endAt: iso(7 * 86_400_000 + 4 * 3_600_000) },
    evidence: proof(`supply-event-${caseId}-revision-1`),
  };
  const announce = (index: number, source: SupplyCandidateAnnouncement['source'], duplicate = false): SupplyCandidateAnnouncement => ({
    id: `announcement-${caseId}-${index}-${duplicate ? 'duplicate' : 'first'}`,
    candidateId: SYNTHETIC_CANDIDATE_IDS[index], label: `${['Cocinera A', 'Cocinero B', 'Cocinera C', 'Cocinero D'][index]} · DEMO`,
    contact: `${SYNTHETIC_CANDIDATE_IDS[index]}@invalid.test`, source,
    sourceLink: `https://${source.replaceAll('_', '-')}.invalid.test/synthetic/${SYNTHETIC_CANDIDATE_IDS[index]}`,
    readAt: new Date(Math.max(0, initializedAtMs - 60_000)).toISOString(),
    city: index === 2 ? null : event.city, coverage: index === 2 ? null : [event.coverage],
    announcedRateCents: index === 3 ? null : [2500, 3000, 2200][index],
    announcedRateUnit: index === 3 ? null : index === 1 ? 'event' : 'hour', currency: index === 3 ? null : 'USD',
  });
  const digestFixtures: SupplyDigestFixture[] = [{
    id: `supply-digest-${caseId}-mixed`, label: 'Digest sintético · anuncia 3 y contiene 5 entradas', announcedCount: 3,
    entries: [announce(0, 'facebook_marketplace'), announce(1, 'facebook_groups'), announce(2, 'outreach_forms'), announce(3, 'meetachef'), announce(0, 'facebook_groups', true)],
    evidence: proof(`supply-digest-${caseId}-mixed`),
  }];
  const terms = (candidateId: string, suffix: string, incomplete = false): SupplyTermsFixture => ({
    id: `supply-terms-${caseId}-${suffix}`, label: `${incomplete ? 'Condiciones incompletas' : 'Condiciones para revisión humana'} · DEMO`, candidateId,
    rateCents: candidateId === SYNTHETIC_CANDIDATE_IDS[0] ? 3500 : 2800, rateUnit: candidateId === SYNTHETIC_CANDIDATE_IDS[0] ? 'hour' : 'event',
    quantity: incomplete ? null : candidateId === SYNTHETIC_CANDIDATE_IDS[0] ? 4 : 1,
    currency: 'USD', totalCents: incomplete ? null : candidateId === SYNTHETIC_CANDIDATE_IDS[0] ? 14_000 : 2800,
    conditions: incomplete ? null : 'Condiciones sintéticas revisadas por humano; no son una oferta, contrato ni aceptación externa.',
    evidence: proof(`supply-terms-${caseId}-${suffix}`),
  });
  const termsFixtures = [terms(SYNTHETIC_CANDIDATE_IDS[0], 'alba-complete'), terms(SYNTHETIC_CANDIDATE_IDS[1], 'beto-complete'), terms(SYNTHETIC_CANDIDATE_IDS[0], 'alba-missing', true)];
  const recipes: SupplyMenuFixture['recipes'] = [{
    id: 'recipe-demo-rice', label: 'Arroz con vegetales · receta DEMO', ingredients: [
      { id: 'ingredient-demo-rice', label: 'Arroz · DEMO', quantityPerServing: 100, unit: 'g' },
      { id: 'ingredient-demo-vegetables', label: 'Vegetales · DEMO', quantityPerServing: 100, unit: 'g' },
    ],
  }];
  const menu = (suffix: string, missing: 'recipe' | 'quantity' | null): SupplyMenuFixture => ({
    id: `supply-menu-${caseId}-${suffix}`, label: `Menú ${missing ? `con ${missing === 'recipe' ? 'receta' : 'cantidad'} faltante` : 'completo'} · DEMO`, menuRevision: 1,
    items: [{ id: 'menu-item-demo-rice', label: 'Arroz con vegetales · DEMO', recipeId: missing === 'recipe' ? null : 'recipe-demo-rice', servings: missing === 'quantity' ? null : 10 }],
    recipes: missing === 'recipe' ? [] : structuredClone(recipes), evidence: proof(`supply-menu-${caseId}-${suffix}`),
  });
  const menuFixtures = [menu('complete', null), menu('missing-recipe', 'recipe'), menu('missing-quantity', 'quantity')];
  const option = (suffix: string, missing: boolean): SupplyPurchaseOptionFixture => ({
    id: `supply-option-${caseId}-${suffix}`, label: `${missing ? 'Opción con datos faltantes' : 'Opción completa'} · DEMO`, service: missing ? 'similar' : 'instacart',
    deliveryAddress: missing ? null : 'Dirección sintética DEMO · Ciudad DEMO · no entregar',
    deliveryWindow: missing ? null : { startAt: iso(6 * 86_400_000), endAt: iso(6 * 86_400_000 + 3_600_000) },
    prices: [{ itemId: 'ingredient-demo-rice', unitPriceCents: missing ? null : 2 }, { itemId: 'ingredient-demo-vegetables', unitPriceCents: missing ? null : 2 }],
    deliveryFeeCents: missing ? null : 500, taxCents: missing ? null : 400, currency: missing ? null : 'USD',
    substitutions: missing ? null : 'no_substitutions_demo', evidence: proof(`supply-option-${caseId}-${suffix}`),
  });
  return structuredClone({ event, digestFixtures, termsFixtures, menuFixtures, optionFixtures: [option('complete', false), option('missing', true)] });
}
