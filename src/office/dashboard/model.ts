import type { Channel, DashboardSnapshot, Metric, Opportunity, Stage } from './contracts';

export const STAGES: Record<Stage, string> = { new: 'Nueva consulta', qualifying: 'Por definir', proposal: 'Propuesta', confirmed: 'Confirmado' };
export const CHANNELS: Record<Channel, string> = { email: 'Correo', web: 'Formulario web', instagram: 'Instagram', messenger: 'Messenger' };
const DAY = 86_400_000;
export function stageAgeDays(opportunity: Opportunity, asOf: string): number | null {
  if (!opportunity.enteredStageAt) return null;
  const start = Date.parse(opportunity.enteredStageAt), end = Date.parse(asOf);
  return Number.isFinite(start) && Number.isFinite(end) && start <= end ? Math.floor((end - start) / DAY) : null;
}
export function formatMoney(amountMinor: number | null, currency: string | null): string {
  if (amountMinor === null || !Number.isSafeInteger(amountMinor) || amountMinor < 0 || !currency || !/^[A-Z]{3}$/.test(currency)) return 'Sin importe verificado';
  try {
    const format = new Intl.NumberFormat('es', { style: 'currency', currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(amountMinor / (10 ** digits));
  } catch { return 'Sin importe verificado'; }
}
export function dashboardMetrics(snapshot: DashboardSnapshot): Metric[] {
  const coverage = snapshot.sources.find(s => s.id === 'sample')?.coverage ?? 'unknown';
  const rows = snapshot.opportunities;
  // A missing amount is not zero; do not add different currencies, unsafe sums,
  // or claim a business total from a partial sample.
  const completeMoney = coverage === 'complete' && rows.length > 0 && rows.every(o => o.amountMinor !== null && Number.isSafeInteger(o.amountMinor) && o.amountMinor >= 0 && o.currency !== null && /^[A-Z]{3}$/.test(o.currency) && o.currency === rows[0].currency);
  const sum = completeMoney ? rows.reduce((total, o) => total + o.amountMinor!, 0) : null;
  const amount = sum !== null && Number.isSafeInteger(sum) ? sum : null;
  return [
    { id: 'opportunities', label: 'Oportunidades de muestra', value: rows.length, unit: 'count', currency: null, coverage, note: 'Registros sintéticos visibles; no es el total del negocio ni leads nuevos del mes.' },
    { id: 'pipeline', label: 'Valor de oportunidades', value: amount, unit: 'money', currency: amount === null ? null : rows[0].currency, coverage: amount === null ? 'unknown' : coverage, note: amount === null ? 'Faltan importes, moneda o cobertura completa. No se presupone un valor cero.' : 'Suma de importes de la muestra completa; no representa ingresos cobrados.' },
    { id: 'conversion', label: 'Conversión', value: null, unit: 'percent', currency: null, coverage: 'unknown', note: 'Sin cohorte, período y resultados verificados. Las etapas de ejemplo no acreditan conversión.' },
    { id: 'revenue', label: 'Ingresos cobrados', value: null, unit: 'money', currency: null, coverage: 'unknown', note: 'Pagos sin conectar. Una propuesta o evento confirmado no acredita ingresos.' },
    { id: 'ads', label: 'Inversión publicitaria', value: null, unit: 'money', currency: null, coverage: 'unknown', note: 'Sin cuenta publicitaria conectada ni período verificado.' },
  ];
}
