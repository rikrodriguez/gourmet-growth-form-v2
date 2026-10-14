import { createHash } from 'node:crypto';
import type { BriefVersion, QuoteVersion } from './event-quote-contracts';

export const escapeQuoteText = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
// No floating point arithmetic, remote resource, user HTML, URL or JavaScript.
export function formatQuoteCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('INVALID_CENTS');
  const value = BigInt(cents); return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
export function renderQuoteArtifact(quote: Omit<QuoteVersion, 'artifact'>, brief: BriefVersion): QuoteVersion['artifact'] {
  const e = escapeQuoteText, money = (value: number) => `${e(quote.currency)} ${formatQuoteCents(value)}`;
  const rows = quote.lines.map(line => `<tr><td>${e(line.label)} (${e(line.unit)})</td><td>${line.qty}</td><td>${money(line.unitPriceCents)}</td><td>${money(Number(BigInt(line.qty) * BigInt(line.unitPriceCents)))}</td></tr>`).join('');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gourmet · Cotización ${e(quote.eventId)} v${quote.version}</title></head><body><main><h1>Gourmet · Cotización v${quote.version}</h1><p>Documento para revisión interna. Sin aceptación del cliente, envío, reserva ni cobro.</p><dl><dt>Expediente</dt><dd>${e(quote.eventId)}</dd><dt>Contacto</dt><dd>${e(brief.contactName)}</dd><dt>Destinatario previsto</dt><dd>${e(brief.recipient)}</dd><dt>Fecha propuesta</dt><dd>${e(brief.proposedDate)}</dd><dt>Lugar propuesto, sin reserva</dt><dd>${e(brief.proposedLocation)}</dd><dt>Asistentes</dt><dd>${brief.attendees}</dd><dt>Brief</dt><dd>v${brief.version} · ${brief.digest}</dd></dl><h2>Consulta original</h2><pre>${e(brief.originalMessage)}</pre><h2>Requisitos</h2><pre>${e(brief.requirements)}</pre><table><caption>Partidas desde catálogo ${e(quote.catalog.id)} · ${e(quote.catalog.version)}</caption><thead><tr><th>Partida</th><th>Cantidad</th><th>Precio unitario</th><th>Importe</th></tr></thead><tbody>${rows}</tbody></table><dl><dt>Subtotal</dt><dd>${money(quote.subtotalCents)}</dd><dt>Impuesto (${quote.catalog.taxBps} puntos básicos)</dt><dd>${money(quote.taxCents)}</dd><dt>Total propuesto</dt><dd>${money(quote.totalCents)}</dd><dt>Anticipo propuesto (${quote.catalog.depositBps} puntos básicos)</dt><dd>${money(quote.depositCents)}</dd></dl><h2>Condiciones del catálogo</h2><pre>${e(quote.catalog.terms)}</pre><p>Fuente: ${e(quote.catalog.source)} · autorización: ${e(quote.catalog.approvalRef)}</p><p>Catálogo válido hasta ${new Date(quote.catalog.validUntilMs).toISOString()}.</p><p>Huella de cotización: ${quote.digest}</p></main></body></html>`;
  return { mediaType: 'text/html; charset=utf-8', html, sha256: createHash('sha256').update(html, 'utf8').digest('hex'), bytes: Buffer.byteLength(html, 'utf8') };
}
