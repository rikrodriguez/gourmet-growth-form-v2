import { expect, Page, Route, test } from '@playwright/test';

const sessionId = 'a4564f18-65e0-4b88-b625-43bda98dfc8d';
const leadId = '9b902ca1-2206-49c6-8b2e-593f8e733768';

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockDashboard(page: Page) {
  let authenticated = false;
  await page.route('**/v1/admin/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/me')) return authenticated
      ? json(route, { user: { staff_user_id: 'staff-1', email: 'admin@gourmet-corporation.com', role: 'admin' } })
      : json(route, { error: 'unauthorized' }, 401);
    if (url.pathname.endsWith('/auth/login')) {
      authenticated = true;
      return json(route, { user: { staff_user_id: 'staff-1', email: 'admin@gourmet-corporation.com', role: 'admin' } });
    }
    if (url.pathname.endsWith('/auth/logout')) { authenticated = false; return route.fulfill({ status: 204 }); }
    if (!authenticated) return json(route, { error: 'unauthorized' }, 401);
    const range = { from: '2026-09-18T07:00:00.000Z', to: '2026-09-25T07:00:00.000Z', label: 'Last 7 days', timezone: 'America/Los_Angeles', include_qa: url.searchParams.get('include_qa') === 'true' };
    const steps = [
      ['sessions','Sessions started',128,128],['guests','Guests completed',122,116],['service','Service completed',112,104],['zip','ZIP completed',100,91],
      ['phone','Phone captured',88,72],['event_type','Event Type completed',69,63],['date','Date completed',60,55],['complete','Name / Form completed',52,49],
    ].map(([step_id,label,entered,completed]) => ({ step_id,label,entered,completed,conversion_from_previous:91.2,conversion_from_session_start:38.3,drop_count:Number(entered)-Number(completed),drop_percentage:7.2,median_step_duration_ms:5200,average_step_duration_ms:7900 }));
    if (url.pathname.endsWith('/overview')) return json(route, { range, reporting_timezone: 'America/Los_Angeles', abandonment_grace_minutes: 10, metrics: { sessions: 128, unique_visitors: 119, leads: 72, completed: 49, session_to_lead_conversion: 56.3, session_to_complete_conversion: 38.3, lead_to_complete_conversion: 68.1, active_sessions: 7, abandoned_sessions: 40, average_completion_ms: 186000, median_completion_ms: 142000 } });
    if (url.pathname.endsWith('/funnel')) return json(route, { range, steps, median_time_to_phone_ms: 68000, median_full_completion_ms: 142000 });
    if (url.pathname === `/v1/admin/sessions/${sessionId}`) return json(route, { session: { session_id: sessionId, status: 'COMPLETED', started_at: '2026-09-24T17:00:00Z', last_seen_at: '2026-09-24T17:04:00Z', last_step_id: 'complete', lead_id: leadId, is_qa: false }, answers: { guest_range: '26-50', service_style: 'full-service', zip_code: '97205', event_type: 'Corporate' }, attribution: [{ touch_kind: 'first', utm_source: 'google', utm_campaign: 'portland-catering', device: 'mobile' }, { touch_kind: 'latest', utm_source: 'google', utm_campaign: 'portland-catering', device: 'mobile' }], timeline: [{ event_id: 'e1', event_name: 'session_started', step_id: 'guests', occurred_at: '2026-09-24T17:00:00Z', step_duration_ms: null }, { event_id: 'e2', event_name: 'phone_captured', step_id: 'phone', occurred_at: '2026-09-24T17:01:08Z', step_duration_ms: 5200 }, { event_id: 'e3', event_name: 'form_completed', step_id: 'complete', occurred_at: '2026-09-24T17:02:22Z', step_duration_ms: 4200 }] });
    if (url.pathname.endsWith('/sessions')) return json(route, { range, next_cursor: null, rows: [{ session_id: sessionId, status: 'COMPLETED', started_at: '2026-09-24T17:00:00Z', last_activity: '2026-09-24T17:04:00Z', last_step_id: 'complete', guest_range: '26-50', service_style: 'full-service', zip_code: '97205', lead_captured: true, source: 'google', campaign: 'portland-catering', device: 'mobile', duration_ms: 142000, is_qa: false }] });
    if (url.pathname === `/v1/admin/leads/${leadId}`) return json(route, { lead: { lead_id: leadId, session_id: sessionId, status: 'completed', intent_cluster: 'bbq', created_at: '2026-09-24T17:01:08Z', is_qa: false }, answers: { first_name: 'QA Test', guest_range: '26-50', service_style: 'full-service', zip_code: '97205', event_type: 'Corporate' } });
    if (url.pathname.endsWith('/leads')) return json(route, { range, next_cursor: null, rows: [{ lead_id: leadId, session_id: sessionId, status: 'completed', created_at: '2026-09-24T17:01:08Z', event_type: 'Corporate', guest_range: '26-50', service_style: 'full-service', zip_code: '97205', time_to_lead_ms: 68000, source: 'google', campaign: 'portland-catering', completed: true, is_qa: false }] });
    if (url.pathname.endsWith('/attribution')) return json(route, { range, groups: { utm_source: [{ value: 'google', sessions: 87, leads: 52, completed: 36, session_to_lead_conversion: 59.8, session_to_complete_conversion: 41.4 }], utm_medium: [], utm_campaign: [{ value: 'portland-catering', sessions: 87, leads: 52, completed: 36, session_to_lead_conversion: 59.8, session_to_complete_conversion: 41.4 }], utm_term: [], device: [{ value: 'mobile', sessions: 80, leads: 45, completed: 31, session_to_lead_conversion: 56.3, session_to_complete_conversion: 38.8 }], network: [], geo: [] } });
    return json(route, { error: 'not_found' }, 404);
  });
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test('secure dashboard covers auth, analytics, details, filters, responsive layout, and logout', async ({ page }, testInfo) => {
  await mockDashboard(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await noOverflow(page);
  await page.getByLabel('Email').fill('admin@gourmet-corporation.com');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Enter dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('56.3%')).toBeVisible();
  await noOverflow(page);

  if (testInfo.project.name.startsWith('mobile')) await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Funnel' }).click();
  await expect(page.getByRole('heading', { name: 'Eight-stage funnel' })).toBeVisible();

  if (testInfo.project.name.startsWith('mobile')) await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Sessions' }).click();
  await expect(page.getByText('portland-catering')).toBeVisible();
  await page.getByText('portland-catering').click();
  await expect(page.getByRole('heading', { name: 'a4564f18…' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Event timeline' })).toBeVisible();
  await page.getByRole('button', { name: 'Close details' }).click();

  if (testInfo.project.name.startsWith('mobile')) await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Leads' }).click();
  await page.getByText('Corporate').click();
  await expect(page.getByText('Phone captured ✓')).toBeVisible();
  await page.getByRole('button', { name: 'Close details' }).click();

  if (testInfo.project.name.startsWith('mobile')) await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Attribution' }).click();
  await expect(page.getByText('google')).toBeVisible();
  await page.getByText('Include QA').click();
  await expect(page.getByText('QA traffic is included in this view.')).toBeVisible();
  await noOverflow(page);

  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

