import React, { useEffect, useId, useRef, useState } from 'react';

/** Local navigation only. Availability is explicitly supplied by the host page. */
export type Section =
  | 'summary' | 'opportunities' | 'inbox' | 'followups'
  | 'events' | 'calendar' | 'tastings' | 'logistics' | 'quotes'
  | 'payments' | 'costs' | 'catalog' | 'analytics'
  | 'contacts' | 'suppliers' | 'team' | 'office' | 'knowledge' | 'sources' | 'reviews' | 'communications';
export type DashboardSection = Section;

const NAV_GROUPS: readonly { label: string; items: readonly { id: Section; label: string }[] }[] = [
  { label: 'VISTA GENERAL', items: [{ id: 'summary', label: 'Dashboard' }, { id: 'opportunities', label: 'Oportunidades' }, { id: 'quotes', label: 'Propuestas' }, { id: 'inbox', label: 'Bandeja' }, { id: 'followups', label: 'Seguimientos' }] },
  { label: 'EVENTOS', items: [{ id: 'events', label: 'Eventos' }, { id: 'calendar', label: 'Calendario' }, { id: 'tastings', label: 'Tastings' }, { id: 'logistics', label: 'Logística' }] },
  { label: 'FINANZAS', items: [{ id: 'payments', label: 'Cobros' }, { id: 'costs', label: 'Costes' }, { id: 'catalog', label: 'Catálogo' }, { id: 'analytics', label: 'Analítica' }] },
  { label: 'PERSONAS', items: [{ id: 'contacts', label: 'Contactos' }, { id: 'suppliers', label: 'Proveedores' }, { id: 'team', label: 'Equipo' }] },
  { label: 'SISTEMA', items: [{ id: 'office', label: 'Oficina' }, { id: 'knowledge', label: 'Conocimiento' }] },
];
const SECTION_TITLES: Record<Section, string> = {
  summary: 'Dashboard', opportunities: 'Oportunidades', inbox: 'Bandeja', followups: 'Seguimientos',
  events: 'Eventos', calendar: 'Calendario', tastings: 'Tastings', logistics: 'Logística', quotes: 'Propuestas',
  payments: 'Cobros', costs: 'Costes', catalog: 'Catálogo', analytics: 'Analítica', contacts: 'Contactos',
  suppliers: 'Proveedores', team: 'Equipo', office: 'Oficina', knowledge: 'Conocimiento', sources: 'Fuentes', reviews: 'Revisión local', communications: 'Comunicaciones',
};

export interface DashboardShellProps {
  section: Section;
  onNavigate: (section: Section) => void;
  children: React.ReactNode;
  title?: string;
  brandName?: string;
  mainId?: string;
  subtitle?: string;
  /** Must be explicitly true before any fictional candidate values are shown. */
  visualDemo?: boolean;
  /** Omitted destinations remain visibly unavailable; no placeholder navigation. */
  enabledSections?: readonly Section[];
  status?: React.ReactNode;
  actions?: React.ReactNode;
  inboxBadgeCount?: number | null;
  /** Event tabs manage their own roving focus; sidebar/history navigation uses the heading. */
  focusHeadingOnSectionChange?: boolean;
}

/** The approved white/gray Gourmet shell. Import approved-dashboard.css in the app entry. */
export function DashboardShell({
  section, onNavigate, children, title, subtitle, visualDemo = false,
  enabledSections = ['summary'], status, actions, inboxBadgeCount, brandName = 'Gourmet', mainId = 'gd-main', focusHeadingOnSectionChange = true,
}: DashboardShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const id = useId();
  const navigationId = `approved-navigation-${id}`;
  const brandInitials = brandName === 'Gourmet' ? 'GC' : brandName.trim().split(/\s+/).slice(0, 2).map(word => word[0] ?? '').join('').toLocaleUpperCase('es');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousSection = useRef(section);
  const activeSection = section;
  const available = new Set(enabledSections);
  available.add('summary');
  available.add('office');
  const safeBadge = typeof inboxBadgeCount === 'number' && Number.isSafeInteger(inboxBadgeCount) && inboxBadgeCount > 0 ? inboxBadgeCount : null;
  useEffect(() => {
    if (previousSection.current !== section) {
      previousSection.current = section;
      setMenuOpen(false);
      if (focusHeadingOnSectionChange) headingRef.current?.focus();
    }
  }, [section, focusHeadingOnSectionChange]);
  const navigate = (next: Section) => {
    if (!available.has(next)) return;
    setMenuOpen(false);
    onNavigate(next);
  };
  return <div className="gourmet-approved" data-visual-demo={visualDemo ? 'true' : 'false'}>
    <a className="ga-skip gd-skip" href={`#${mainId}`}>Saltar al contenido</a>
    <aside className="ga-sidebar" aria-label={brandName}>
      <div className="ga-mobile-heading"><div className="ga-brand">{brandName.toLocaleUpperCase('es')}</div>
        <button className="ga-menu-toggle" type="button" aria-controls={navigationId} aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}>{menuOpen ? 'Cerrar menú' : 'Menú'}</button>
      </div>
      <div className="ga-navigation-container" id={navigationId} data-open={menuOpen ? 'true' : 'false'}>
        <nav className="ga-navigation" aria-label="Navegación del dashboard">
          {NAV_GROUPS.map(group => <div className="ga-nav-group" key={group.label}>
            <p className="ga-group-label">{group.label}</p>
            {group.items.filter(item => item.id !== 'quotes' || available.has('quotes')).map(item => item.id === 'office' ? <a className="ga-nav-item" key={item.id} href="/office/" aria-current={section === 'office' ? 'page' : undefined}><span>{item.label}</span></a> : <button key={item.id} type="button" className="ga-nav-item"
              disabled={!available.has(item.id)} title={!available.has(item.id) ? `${item.label}: pendiente de implementación` : undefined}
              aria-current={activeSection === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)}>
              <span>{item.id === 'payments' && available.has('payments') ? 'Enlaces de pago' : item.label}</span>
              {item.id === 'inbox' && safeBadge !== null && <span className="ga-inbox-badge" aria-label={`${safeBadge} elementos ${visualDemo ? 'de demostración' : 'en la vista local'}`}>{safeBadge}</span>}
              {!available.has(item.id) && <span className="ga-unavailable-dot" aria-hidden="true" />}
            </button>)}
          </div>)}
        </nav>
        <div className="ga-sidebar-footer">
          <span className="ga-support" title="Pendiente de implementación">Asistente de soporte</span>
          <div className="ga-booking"><span className="ga-connection-dot" aria-hidden="true" /><strong>Coordinación de tastings</strong><span>Pendiente de conexión</span></div>
          <div className="ga-theme" title="Modo oscuro pendiente de implementación"><span>Modo oscuro</span><span className="ga-theme-switch" aria-hidden="true" /></div>
          <div className="ga-profile"><span className="ga-avatar" aria-hidden="true">{brandInitials}</span><strong>{brandName}</strong><span>Vista de dirección</span></div>
          {available.has('reviews') && <button type="button" className="ga-sources-link" aria-current={section === 'reviews' ? 'page' : undefined} onClick={() => navigate('reviews')}>Revisión local</button>}
          {available.has('communications') && <a className="ga-sources-link" href="/office/communications">Comunicaciones</a>}
          {available.has('sources') && <button type="button" className="ga-sources-link" aria-current={section === 'sources' ? 'page' : undefined} onClick={() => navigate('sources')}>Fuentes</button>}
        </div>
      </div>
    </aside>
    <main className="ga-main" id={mainId} tabIndex={-1}>
      <header className="ga-heading">
        <div className="ga-heading-copy"><h1 ref={headingRef} tabIndex={-1}>{title ?? SECTION_TITLES[section]}</h1><p>{subtitle ?? (section === 'summary' ? 'Todo el negocio, en una sola vista.' : 'Vista local de Gourmet.')}</p></div>
        <span className="ga-mode-label">{visualDemo ? 'DEMO' : 'VISTA LOCAL'} · {brandName.toLocaleUpperCase('es')}</span>
        {actions && <div className="ga-heading-actions">{actions}</div>}
      </header>
      {status && <div className="ga-status">{status}</div>}
      <div className="ga-content">{children}</div>
    </main>
  </div>;
}

export interface ApprovedDashboardSummaryProps {
  /** False by default: unavailable actual data are unknown, never zero or demo. */
  visualDemo?: boolean;
  /** Optional local navigation only; this component cannot send or approve. */
  onOpenInbox?: () => void;
  /** Count supplied by the local source. Omitted/invalid means unknown, not zero. */
  sampleOpportunityCount?: number;
}

/** Approved visual scenario only. None of these values come from connected sources. */
export const APPROVED_VISUAL_DEMO = {
  metrics: [
    { id: 'pipeline', label: 'Valor del pipeline', value: '18.400', note: '20 oportunidades con valor de muestra' },
    { id: 'contacts', label: 'Nuevos contactos este mes', value: '38', note: 'contactos del escenario' },
    { id: 'conversion', label: 'Conversión de propuestas', value: '68%', note: '17 de 25 propuestas del escenario' },
  ],
  ads: [
    { label: 'Inversión', value: '1.120' }, { label: 'Consultas por mensajes', value: '11' },
    { label: 'Consultas web', value: '8' }, { label: 'Coste por consulta', value: '59' },
  ],
  months: [
    { label: 'May', value: '3,7k', height: 89 }, { label: 'Jun', value: '3,9k', height: 94 },
    { label: 'Jul', value: '4,2k', height: 101 }, { label: 'Ago', value: '4,5k', height: 109 },
    { label: 'Sep', value: '4,6k', height: 111 }, { label: 'Oct', value: '4,8k', height: 116 },
  ],
  pendingDrafts: 4,
  activity: [
    { label: 'Nueva consulta web de Aurora · Cena de equipo', relativeTime: 'hace 2 min' },
    { label: 'Propuesta v2 preparada · 24 invitados', relativeTime: 'hace 8 min' },
  ],
} as const;

/** Explicit visual demo, separate from the read model and any real approval queue. */
export function ApprovedDashboardSummary({ visualDemo = false, onOpenInbox, sampleOpportunityCount }: ApprovedDashboardSummaryProps) {
  const id = useId();
  const disclosureId = `approved-disclosure-${id}`;
  const sampleCount = typeof sampleOpportunityCount === 'number' && Number.isSafeInteger(sampleOpportunityCount) && sampleOpportunityCount >= 0 ? sampleOpportunityCount : null;
  const metrics = visualDemo ? APPROVED_VISUAL_DEMO.metrics : [
    { id: 'pipeline', label: 'Valor del pipeline', value: '—', note: 'Sin fuente ni periodo verificados' },
    { id: 'opportunities', label: 'Oportunidades de muestra', value: sampleCount === null ? '—' : String(sampleCount), note: sampleCount === null ? 'Muestra local sin consultar' : 'Registros de la muestra local sintética' },
    { id: 'conversion', label: 'Conversión de propuestas', value: '—', note: 'Sin fuente ni periodo verificados' },
  ];
  const inboxNote = visualDemo ? 'Abre la bandeja para leer, editar y revisar cada respuesta.' : 'La cola real no se ha consultado. Las respuestas requieren revisión y autorización.';
  return <div className="ga-summary" data-testid="approved-dashboard-summary" data-visual-demo={visualDemo ? 'true' : 'false'} aria-describedby={disclosureId}>
    <div className="ga-metrics" aria-label={visualDemo ? 'Indicadores ficticios de demostración' : 'Indicadores sin verificar'}>
      {metrics.map(metric => <article className="ga-panel ga-metric" key={metric.id} data-testid={`approved-metric-${metric.id}`}>
        <h2>{metric.label}</h2><p className="ga-metric-value">{metric.value}</p><p className="ga-metric-note">{metric.note}</p>
      </article>)}
    </div>
    <section className="ga-panel ga-ads" aria-labelledby={`ga-ads-${id}`}>
      <h2 id={`ga-ads-${id}`}>Meta Ads</h2><div className="ga-ad-row">{APPROVED_VISUAL_DEMO.ads.map(ad => <div className="ga-ad" key={ad.label} data-testid="approved-ad-cell"><p className="ga-ad-label">{ad.label}</p><p className="ga-ad-value">{visualDemo ? ad.value : '—'}</p></div>)}</div>
      {!visualDemo && <p className="ga-ads-unknown">Sin cuenta ni atribución verificadas.</p>}
    </section>
    <section className="ga-panel ga-revenue" aria-labelledby={`ga-revenue-${id}`} data-testid="approved-revenue-history">
      <header className="ga-revenue-heading"><h2 id={`ga-revenue-${id}`}>Ingresos reservados</h2>
        <div className="ga-period" aria-label="Periodo de la muestra"><span className="ga-period-selected">6 meses</span><span className="ga-period-unavailable" title="No hay una muestra de 12 meses disponible">12 meses<span className="ga-visually-hidden">, no disponible</span></span></div>
      </header>
      {visualDemo ? <ol className="ga-chart" aria-label="Reservas ficticias de mayo a octubre, en unidades DEMO; no representan ingresos cobrados">
        {APPROVED_VISUAL_DEMO.months.map(month => <li className="ga-month" key={month.label} data-testid="approved-revenue-bar" style={{ '--ga-bar-height': `${month.height}px` } as React.CSSProperties}>
          <span className="ga-chart-value">{month.value}</span><span className="ga-bar" aria-hidden="true" /><span className="ga-month-label">{month.label}</span>
        </li>)}
      </ol> : <div className="ga-revenue-unknown"><strong>—</strong><p>Ingresos reservados sin verificar</p><span>Sin fuente conectada. Una reserva no acredita un cobro.</span></div>}
    </section>
    <section className="ga-panel ga-assistants" aria-labelledby={`ga-assistants-${id}`}>
      <h2 id={`ga-assistants-${id}`}>Asistentes IA</h2>
      <div className="ga-assistants-body"><div className="ga-pending"><strong>{visualDemo ? APPROVED_VISUAL_DEMO.pendingDrafts : '—'}</strong><p>{visualDemo ? <>borradores esperando<br />tu revisión</> : <>Borradores reales<br />sin consultar</>}</p></div>
        <div className="ga-agent-rows">
          <div className="ga-agent-line"><strong>Correo y propuestas</strong><span className="ga-agent-status">{visualDemo ? 'DEMO' : 'SIN CONEXIÓN'}</span><span className="ga-agent-description">{visualDemo ? 'Respuestas preparadas para tu aprobación' : 'No se ha consultado ninguna cuenta real'}</span></div>
          <div className="ga-agent-line"><strong>Instagram + Messenger</strong><span className="ga-agent-status">{visualDemo ? 'DEMO' : 'SIN CONEXIÓN'}</span><span className="ga-agent-description">{visualDemo ? 'Consultas reunidas en una sola bandeja' : 'Fuentes pendientes de conectar'}</span></div>
        </div>
      </div>
      {onOpenInbox ? <button className="ga-agent-note ga-inline-action" type="button" onClick={onOpenInbox}>{inboxNote}</button> : <p className="ga-agent-note">{inboxNote}</p>}
    </section>
    <section className="ga-panel ga-activity" aria-labelledby={`ga-activity-${id}`}>
      <h2 id={`ga-activity-${id}`}>Actividad reciente</h2>
      {visualDemo ? <ol>{APPROVED_VISUAL_DEMO.activity.map(item => <li key={item.label}><span>{item.label}</span><span className="ga-activity-time">{item.relativeTime}</span></li>)}</ol> : <p className="ga-activity-unknown">Actividad real sin consultar. No hay una fuente verificada.</p>}
    </section>
    <p className="ga-disclosure" id={disclosureId} data-testid="approved-dashboard-disclosure">{visualDemo ? 'Propuesta visual · Cifras ficticias en unidades DEMO · Sin cuentas conectadas' : 'Vista local · Datos reales desconocidos · Sin cuentas conectadas'}</p>
  </div>;
}
