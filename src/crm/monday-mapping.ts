import type { CrmLeadSnapshot, MondayColumnValues } from './contracts';

export const MONDAY_COLUMNS = {
  phone: 'phone_mm1en86x',
  status: 'color_mm1e35nf',
  eventDate: 'date_mm1ehb3s',
  guests: 'text_mm1er9bx',
  geo: 'text_mm1ep70d',
  zip: 'text_mm1eft09',
  eventType: 'text_mm1e3hn',
  service: 'text_mm1ed0nr',
  keyword: 'text_mm1epjsq',
  fullUrl: 'text_mm1er3gk',
  creationDate: 'date_mm1e8frh',
} as const;

export const EXPECTED_COLUMNS: Record<string, { title: string; type: string }> = {
  [MONDAY_COLUMNS.phone]: { title: 'Phone', type: 'phone' },
  [MONDAY_COLUMNS.status]: { title: 'Lead Status', type: 'status' },
  [MONDAY_COLUMNS.eventDate]: { title: 'Event Date', type: 'date' },
  [MONDAY_COLUMNS.guests]: { title: 'Guests', type: 'text' },
  [MONDAY_COLUMNS.geo]: { title: 'Geo', type: 'text' },
  [MONDAY_COLUMNS.zip]: { title: 'ZIP Code', type: 'text' },
  [MONDAY_COLUMNS.eventType]: { title: 'Event Type', type: 'text' },
  [MONDAY_COLUMNS.service]: { title: 'Service Style', type: 'text' },
  [MONDAY_COLUMNS.keyword]: { title: 'Google Keyword', type: 'text' },
  [MONDAY_COLUMNS.fullUrl]: { title: 'Full URL', type: 'text' },
  [MONDAY_COLUMNS.creationDate]: { title: 'Creation Date', type: 'date' },
};

const GUESTS: Record<string, string> = {
  '10-25': '10-25 Guests',
  '26-50': '26-50 Guests',
  '51-100': '51-100 Guests',
  '101-200': '101-200 Guests',
  '201+': '201+ Guests',
  'not-sure': 'Not sure yet',
};

const SERVICES: Record<string, string> = {
  'full-service': 'Full Service Staff',
  buffet: 'Buffet Setup',
  'drop-off': 'Drop-off & Go',
  'not-sure': 'Not sure yet',
};

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function mondayItemName(lead: CrmLeadSnapshot): string {
  const prefix = lead.isQa ? '[QA] ' : '';
  const firstName = lead.answers.first_name?.trim();
  return firstName ? `${prefix}${firstName}` : `${prefix}BBQ Lead — ${lead.leadId.slice(0, 6)}`;
}

function commonColumns(lead: CrmLeadSnapshot, phone: string): MondayColumnValues {
  const values: MondayColumnValues = {
    [MONDAY_COLUMNS.phone]: { phone: `+1${phone}`, countryShortName: 'US' },
    [MONDAY_COLUMNS.guests]: lead.answers.guest_range ? GUESTS[lead.answers.guest_range] ?? lead.answers.guest_range : null,
    [MONDAY_COLUMNS.zip]: lead.answers.zip_code ?? null,
    [MONDAY_COLUMNS.service]: lead.answers.service_style ? SERVICES[lead.answers.service_style] ?? lead.answers.service_style : null,
    [MONDAY_COLUMNS.eventType]: lead.answers.event_type ?? null,
    [MONDAY_COLUMNS.keyword]: lead.utmTerm,
    [MONDAY_COLUMNS.fullUrl]: lead.landingUrl,
    [MONDAY_COLUMNS.creationDate]: { date: dateOnly(lead.createdAt) },
    [MONDAY_COLUMNS.eventDate]: lead.answers.date_window === 'exact' && lead.answers.exact_date
      ? { date: lead.answers.exact_date }
      : null,
  };
  return values;
}

export function mondayCreateColumns(lead: CrmLeadSnapshot, phone: string): MondayColumnValues {
  return { ...commonColumns(lead, phone), [MONDAY_COLUMNS.status]: { label: 'New' } };
}

export function mondayUpdateColumns(lead: CrmLeadSnapshot, phone: string): MondayColumnValues {
  return { name: mondayItemName(lead), ...commonColumns(lead, phone) };
}

