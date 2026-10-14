import { useRef, useState, type FormEvent } from 'react';
import type { LeadLinkView, VerifiedLeadAgreement } from './lead-link-view-contracts';
const labels: Record<string,string> = { calculator:'Calculator · Calculadora', lead_notes:'AI Notes · Notas del lead', sales_closer:'AI Closer · Asistente comercial', landing_attribution:'FullURL · Página de origen', quote:'Quotes · Cotización', update_link:'Enlace de actualización' };
export type LeadLinkOpeningContext = { identityKey: string; csrfToken: string; expiresAtMs: number; current(): boolean };
export function LeadLinkHistoryPanel({ leadId, history, agreement, openingContext = null }: { leadId: string; history: LeadLinkView; agreement: VerifiedLeadAgreement | null; openingContext?: LeadLinkOpeningContext | null }) {
  const submitted = useRef(new Set<string>()); const [,rerender] = useState(0);
  function submit(event: FormEvent<HTMLFormElement>, key: string) {
    let valid = false; try { valid = !!openingContext?.current(); } catch { /* A failed permission check cannot submit. */ }
    if (!openingContext || !valid || Date.now() >= openingContext.expiresAtMs || submitted.current.has(key)) { event.preventDefault(); return; }
    submitted.current.add(key); rerender(value => value + 1);
  }
  // Secondary display guard; authorization belongs to the server-side mapping.
  if (history.leadId !== leadId || (agreement !== null && agreement.leadId !== leadId)) return <p role="alert">Historial fuera del lead seleccionado.</p>;
  return <section aria-label="Enlaces históricos del lead" className="lead-link-history">
    <h2>Enlaces e historial de origen</h2>
    <p>Consulta conservada y procedencia. Un valor de columna no acredita que sea la primera consulta. Estos enlaces no acreditan visitas humanas ni conversiones.</p>
    {openingContext && <p>Al abrir, el servicio de destino recibirá el enlace original y puede registrar la visita. No se abre ni se sigue ningún destino antes de tu clic.</p>}
    <section aria-label="Último acuerdo verificado"><h3>Último acuerdo verificado</h3>
      {agreement ? <><p><strong>{agreement.guests} invitados</strong> · {agreement.menu} · {agreement.amountLabel}</p><p>{agreement.evidenceLabel} · {agreement.verifiedAt}</p></> : <p>Sin acuerdo verificado disponible.</p>}
    </section>
    {history.links.length === 0 && <p>Sin enlaces históricos en este alcance.</p>}
    <ul>{history.links.map((link, index) => <li key={`${link.columnId ?? link.updateId}-${index}`}>
      <h3>{labels[link.category] ?? 'Enlace histórico'}</h3>
      <p>{link.status === 'missing' ? 'Enlace no registrado' : link.status === 'quarantined' ? 'Pendiente de revisión de identidad o destino' : 'Referencia histórica conservada'}</p>
      {link.recordedGuests !== null && <p>Consulta conservada en enlace: {link.recordedGuests} invitados{agreement && agreement.guests !== link.recordedGuests ? ' · Diferencia histórica respecto al acuerdo verificado' : ''}</p>}
      <p>Campaña: {link.campaignLabel ?? 'Sin etiqueta verificada'}</p>
      <p>Señales de atribución: {link.attributionIndicators.length ? link.attributionIndicators.map(kind => ({utm:'UTM',google_click_id:'Identificador de clic Google',google_campaign_id:'Identificador de campaña Google'})[kind]).join(' · ') : 'Sin señal visible verificada'}. Evidencia histórica; visita y conversión sin verificar.</p>
      <p>Procedencia: {link.evidenceKind === 'column_snapshot' ? 'Valor observado en columna' : 'Enlace en actualización histórica'}</p>
      <dl><dt>Cuenta / tablero / ítem</dt><dd>{link.accountId} / {link.boardId} / {link.itemId}</dd>
        <dt>{link.columnId === null ? 'Actualización' : 'Columna'}</dt><dd>{link.columnId ?? link.updateId}</dd>
        <dt>Observado</dt><dd>{link.observedAt}</dd><dt>Fecha del cambio en origen</dt><dd>{link.changedAt ?? 'No disponible'}</dd></dl>
      <p>URL y parámetros originales protegidos.</p>
      {link.opening && openingContext ? <form action="/api/office/lead-link-open" method="post" target="_blank" rel="noopener noreferrer" onSubmit={event => submit(event,`${link.opening!.referenceId}:${link.opening!.revision}`)}>
        <input type="hidden" name="identityKey" value={openingContext.identityKey}/><input type="hidden" name="leadId" value={leadId}/>
        <input type="hidden" name="referenceId" value={link.opening.referenceId}/><input type="hidden" name="revision" value={link.opening.revision}/><input type="hidden" name="csrfToken" value={openingContext.csrfToken}/>
        <button type="submit" className="gew-button" disabled={submitted.current.has(`${link.opening.referenceId}:${link.opening.revision}`) || Date.now() >= openingContext.expiresAtMs}>Abrir {({calculator:'Calculator',lead_notes:'AI Notes',sales_closer:'AI Closer',quote:'Quotes'} as Record<string,string>)[link.category] ?? 'referencia'}</button>
        {submitted.current.has(`${link.opening.referenceId}:${link.opening.revision}`) && <p role="status">Apertura solicitada en otra pestaña. Vuelve a consultar el historial si necesitas abrirlo otra vez.</p>}
      </form> : <p>{link.category === 'landing_attribution' ? 'Referencia de atribución; navegación no habilitada.' : 'Sin permiso de apertura o destino revisado disponible.'}</p>}
    </li>)}</ul>
  </section>;
}
