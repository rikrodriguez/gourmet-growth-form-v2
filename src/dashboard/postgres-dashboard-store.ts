import pg from 'pg';
import type {
  AuthenticatedStaff,
  DashboardListFilters,
  DashboardStore,
  ReportingRange,
  StaffUser,
} from './contracts';
import { decodeCursor, encodeCursor } from './filters';

const { Pool } = pg;

function number(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(1)) : 0;
}

function rangeMeta(range: ReportingRange) {
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    label: range.label,
    timezone: range.timezone,
    include_qa: range.includeQa,
  };
}

export function createPostgresDashboardStore(databaseUrl: string): DashboardStore {
  return new PostgresDashboardStore(new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 }));
}

export class PostgresDashboardStore implements DashboardStore {
  constructor(private readonly pool: pg.Pool) {}

  async health() {
    await this.pool.query('SELECT 1');
  }

  async findStaffByEmail(email: string): Promise<StaffUser | null> {
    const result = await this.pool.query(
      `SELECT staff_user_id, email, password_hash, role, enabled
       FROM growth_v2.staff_users WHERE email = $1`,
      [email],
    );
    const row = result.rows[0];
    return row ? {
      staffUserId: row.staff_user_id,
      email: row.email,
      passwordHash: row.password_hash,
      role: row.role,
      enabled: row.enabled,
    } : null;
  }

  async rotateStaffSession(staffUserId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE growth_v2.staff_sessions SET revoked_at = now()
         WHERE staff_user_id = $1 AND revoked_at IS NULL`,
        [staffUserId],
      );
      await client.query(
        `INSERT INTO growth_v2.staff_sessions
          (staff_session_id, staff_user_id, token_hash, expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3)`,
        [staffUserId, tokenHash, expiresAt],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async authenticateStaff(tokenHash: string): Promise<AuthenticatedStaff | null> {
    const result = await this.pool.query(
      `UPDATE growth_v2.staff_sessions ss
       SET last_seen_at = now()
       FROM growth_v2.staff_users su
       WHERE ss.staff_user_id = su.staff_user_id
         AND ss.token_hash = $1
         AND ss.revoked_at IS NULL
         AND ss.expires_at > now()
         AND su.enabled = true
       RETURNING ss.staff_session_id, ss.expires_at,
                 su.staff_user_id, su.email, su.role, su.enabled`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? {
      staffSessionId: row.staff_session_id,
      expiresAt: row.expires_at.toISOString(),
      staffUserId: row.staff_user_id,
      email: row.email,
      role: row.role,
      enabled: row.enabled,
    } : null;
  }

  async revokeStaffSession(tokenHash: string): Promise<void> {
    await this.pool.query(
      'UPDATE growth_v2.staff_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash],
    );
  }

  async recordLogin(staffUserId: string): Promise<void> {
    await this.pool.query(
      'UPDATE growth_v2.staff_users SET last_login_at = now(), updated_at = now() WHERE staff_user_id = $1',
      [staffUserId],
    );
  }

  async overview(range: ReportingRange, graceMinutes: number): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `WITH session_base AS (
         SELECT s.session_id, s.visitor_id, s.started_at,
                GREATEST(s.last_seen_at, COALESCE(max(e.occurred_at), s.last_seen_at)) AS last_activity,
                COALESCE(s.completed_at, max(e.occurred_at) FILTER (WHERE e.event_name = 'form_completed')) AS completed_at,
                bool_or(l.lead_id IS NOT NULL) AS has_lead
         FROM growth_v2.sessions s
         LEFT JOIN growth_v2.events e ON e.session_id = s.session_id
         LEFT JOIN growth_v2.leads l ON l.session_id = s.session_id AND l.deleted_at IS NULL
         WHERE s.started_at >= $1 AND s.started_at < $2
           AND ($3::boolean OR NOT s.is_qa) AND s.deleted_at IS NULL
         GROUP BY s.session_id
       ), classified AS (
         SELECT *, CASE
           WHEN completed_at IS NOT NULL THEN 'COMPLETED'
           WHEN last_activity >= now() - make_interval(mins => $4) THEN 'ACTIVE'
           WHEN has_lead THEN 'LEAD_CAPTURED'
           ELSE 'ABANDONED'
         END AS derived_status
         FROM session_base
       )
       SELECT count(*)::int AS sessions,
              count(DISTINCT visitor_id)::int AS unique_visitors,
              count(*) FILTER (WHERE has_lead)::int AS leads,
              count(*) FILTER (WHERE completed_at IS NOT NULL)::int AS completed,
              count(*) FILTER (WHERE derived_status = 'ACTIVE')::int AS active,
              count(*) FILTER (WHERE derived_status = 'ABANDONED')::int AS abandoned,
              avg(extract(epoch FROM (completed_at - started_at)) * 1000)
                FILTER (WHERE completed_at IS NOT NULL) AS avg_completion_ms,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY extract(epoch FROM (completed_at - started_at)) * 1000
              ) FILTER (WHERE completed_at IS NOT NULL) AS median_completion_ms
       FROM classified`,
      [range.from, range.to, range.includeQa, graceMinutes],
    );
    const row = result.rows[0];
    const sessions = number(row.sessions);
    const leads = number(row.leads);
    const completed = number(row.completed);
    return {
      range: rangeMeta(range),
      metrics: {
        sessions,
        unique_visitors: number(row.unique_visitors),
        leads,
        completed,
        session_to_lead_conversion: percent(leads, sessions),
        session_to_complete_conversion: percent(completed, sessions),
        lead_to_complete_conversion: percent(completed, leads),
        active_sessions: number(row.active),
        abandoned_sessions: number(row.abandoned),
        average_completion_ms: row.avg_completion_ms === null ? null : Math.round(number(row.avg_completion_ms)),
        median_completion_ms: row.median_completion_ms === null ? null : Math.round(number(row.median_completion_ms)),
      },
      abandonment_grace_minutes: graceMinutes,
    };
  }

  async funnel(range: ReportingRange): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `WITH cohort AS (
         SELECT session_id FROM growth_v2.sessions
         WHERE started_at >= $1 AND started_at < $2
           AND ($3::boolean OR NOT is_qa) AND deleted_at IS NULL
       ), flags AS (
         SELECT c.session_id,
           bool_or(e.event_name = 'step_viewed' AND e.step_id = 'guests') AS guests_entered,
           bool_or(e.event_name = 'step_completed' AND e.step_id = 'guests') AS guests_completed,
           bool_or(e.event_name = 'step_viewed' AND e.step_id = 'service') AS service_entered,
           bool_or(e.event_name = 'step_completed' AND e.step_id = 'service') AS service_completed,
           bool_or(e.event_name = 'step_viewed' AND e.step_id = 'zip') AS zip_entered,
           bool_or(e.event_name = 'step_completed' AND e.step_id = 'zip') AS zip_completed,
           bool_or(e.event_name = 'step_viewed' AND e.step_id = 'phone') AS phone_entered,
           bool_or(e.event_name = 'phone_captured') AS phone_completed,
           bool_or(e.event_name = 'step_viewed' AND e.step_id = 'event_type') AS event_type_entered,
           bool_or(e.event_name = 'step_completed' AND e.step_id = 'event_type') AS event_type_completed,
           bool_or(e.event_name = 'step_viewed' AND e.step_id = 'date') AS date_entered,
           bool_or(e.event_name = 'step_completed' AND e.step_id = 'date') AS date_completed,
           bool_or(e.event_name = 'step_viewed' AND e.step_id = 'name') AS complete_entered,
           bool_or(e.event_name = 'form_completed') AS complete_completed
         FROM cohort c LEFT JOIN growth_v2.events e ON e.session_id = c.session_id
         GROUP BY c.session_id
       ), timings AS (
         SELECT e.step_id,
                avg(e.step_duration_ms) FILTER (WHERE e.step_duration_ms IS NOT NULL) AS average_ms,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY e.step_duration_ms)
                  FILTER (WHERE e.step_duration_ms IS NOT NULL) AS median_ms
         FROM growth_v2.events e JOIN cohort c ON c.session_id = e.session_id
         WHERE e.event_name = 'step_completed'
         GROUP BY e.step_id
       )
       SELECT (SELECT count(*) FROM cohort)::int AS sessions,
              row_to_json(counts) AS counts,
              COALESCE((SELECT jsonb_object_agg(step_id, jsonb_build_object(
                'average_ms', round(average_ms), 'median_ms', round(median_ms))) FROM timings), '{}'::jsonb) AS timings
       FROM (SELECT
         count(*) FILTER (WHERE guests_entered)::int AS guests_entered,
         count(*) FILTER (WHERE guests_completed)::int AS guests_completed,
         count(*) FILTER (WHERE service_entered)::int AS service_entered,
         count(*) FILTER (WHERE service_completed)::int AS service_completed,
         count(*) FILTER (WHERE zip_entered)::int AS zip_entered,
         count(*) FILTER (WHERE zip_completed)::int AS zip_completed,
         count(*) FILTER (WHERE phone_entered)::int AS phone_entered,
         count(*) FILTER (WHERE phone_completed)::int AS phone_completed,
         count(*) FILTER (WHERE event_type_entered)::int AS event_type_entered,
         count(*) FILTER (WHERE event_type_completed)::int AS event_type_completed,
         count(*) FILTER (WHERE date_entered)::int AS date_entered,
         count(*) FILTER (WHERE date_completed)::int AS date_completed,
         count(*) FILTER (WHERE complete_entered)::int AS complete_entered,
         count(*) FILTER (WHERE complete_completed)::int AS complete_completed
       FROM flags) counts`,
      [range.from, range.to, range.includeQa],
    );
    const summary = await this.pool.query(
      `WITH cohort AS (
         SELECT session_id, started_at FROM growth_v2.sessions
         WHERE started_at >= $1 AND started_at < $2
           AND ($3::boolean OR NOT is_qa) AND deleted_at IS NULL
       ), durations AS (
         SELECT c.session_id,
           extract(epoch FROM (min(e.occurred_at) FILTER (WHERE e.event_name='phone_captured') - c.started_at))*1000 AS phone_ms,
           extract(epoch FROM (min(e.occurred_at) FILTER (WHERE e.event_name='form_completed') - c.started_at))*1000 AS complete_ms
         FROM cohort c LEFT JOIN growth_v2.events e ON e.session_id=c.session_id GROUP BY c.session_id,c.started_at
       ) SELECT
         percentile_cont(0.5) WITHIN GROUP (ORDER BY phone_ms) FILTER (WHERE phone_ms >= 0) AS median_phone_ms,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY complete_ms) FILTER (WHERE complete_ms >= 0) AS median_complete_ms
       FROM durations`,
      [range.from, range.to, range.includeQa],
    );
    const row = result.rows[0];
    const counts = row.counts as Record<string, number>;
    const definitions = [
      ['sessions', 'Sessions started'], ['guests', 'Guests completed'], ['service', 'Service completed'],
      ['zip', 'ZIP completed'], ['phone', 'Phone captured'], ['event_type', 'Event Type completed'],
      ['date', 'Date completed'], ['complete', 'Name / Form completed'],
    ] as const;
    const sessionCount = number(row.sessions);
    let previous = sessionCount;
    const steps = definitions.map(([id, label], index) => {
      const entered = index === 0 ? sessionCount : number(counts[`${id}_entered`]);
      const completed = index === 0 ? sessionCount : number(counts[`${id}_completed`]);
      const resultStep = {
        step_id: id,
        label,
        entered,
        completed,
        conversion_from_previous: percent(completed, previous),
        conversion_from_session_start: percent(completed, sessionCount),
        drop_count: Math.max(0, entered - completed),
        drop_percentage: percent(Math.max(0, entered - completed), entered),
        average_step_duration_ms: row.timings[id]?.average_ms ?? null,
        median_step_duration_ms: row.timings[id]?.median_ms ?? null,
      };
      previous = completed;
      return resultStep;
    });
    return {
      range: rangeMeta(range),
      steps,
      median_time_to_phone_ms: summary.rows[0].median_phone_ms === null ? null : Math.round(number(summary.rows[0].median_phone_ms)),
      median_full_completion_ms: summary.rows[0].median_complete_ms === null ? null : Math.round(number(summary.rows[0].median_complete_ms)),
    };
  }

  async sessions(filters: DashboardListFilters, graceMinutes: number): Promise<Record<string, unknown>> {
    const cursor = decodeCursor(filters.cursor);
    const result = await this.pool.query(
      `WITH base AS (
        SELECT s.session_id, s.visitor_id, s.intent_cluster, s.started_at,
          GREATEST(s.last_seen_at, COALESCE(max(e.occurred_at), s.last_seen_at)) AS last_activity,
          COALESCE(s.completed_at, max(e.occurred_at) FILTER (WHERE e.event_name='form_completed')) AS completed_at,
          s.last_step_id, s.last_step_index, s.is_qa, l.lead_id,
          max(a.field_value) FILTER (WHERE a.field_key='guest_range') AS guest_range,
          max(a.field_value) FILTER (WHERE a.field_key='service_style') AS service_style,
          max(a.field_value) FILTER (WHERE a.field_key='zip_code') AS zip_code,
          max(t.utm_source) FILTER (WHERE t.touch_kind='latest') AS source,
          max(t.utm_campaign) FILTER (WHERE t.touch_kind='latest') AS campaign,
          max(t.device) FILTER (WHERE t.touch_kind='latest') AS device
        FROM growth_v2.sessions s
        LEFT JOIN growth_v2.events e ON e.session_id=s.session_id
        LEFT JOIN growth_v2.leads l ON l.session_id=s.session_id AND l.deleted_at IS NULL
        LEFT JOIN growth_v2.lead_answers a ON a.lead_id=l.lead_id AND a.cleared_at IS NULL
        LEFT JOIN growth_v2.attribution_touches t ON t.session_id=s.session_id
        WHERE s.started_at >= $1 AND s.started_at < $2 AND ($3::boolean OR NOT s.is_qa)
          AND s.deleted_at IS NULL
        GROUP BY s.session_id,l.lead_id
      ), classified AS (
        SELECT *, CASE WHEN completed_at IS NOT NULL THEN 'COMPLETED'
          WHEN last_activity >= now()-make_interval(mins=>$4) THEN 'ACTIVE'
          WHEN lead_id IS NOT NULL THEN 'LEAD_CAPTURED' ELSE 'ABANDONED' END AS status
        FROM base
      ) SELECT *, extract(epoch FROM (COALESCE(completed_at,last_activity)-started_at))*1000 AS duration_ms
        FROM classified
        WHERE ($5::text IS NULL OR status=$5)
          AND ($6::text IS NULL OR last_step_id=$6)
          AND ($7::text IS NULL OR source=$7)
          AND ($8::text IS NULL OR campaign=$8)
          AND ($9::text IS NULL OR intent_cluster=$9)
          AND ($10::uuid IS NULL OR session_id=$10)
          AND ($11::timestamptz IS NULL OR (started_at,session_id) < ($11::timestamptz,$12::uuid))
        ORDER BY started_at DESC,session_id DESC LIMIT $13`,
      [filters.from, filters.to, filters.includeQa, graceMinutes, filters.status, filters.step,
        filters.source, filters.campaign, filters.intentCluster, filters.exactId,
        cursor?.[0] ?? null, cursor?.[1] ?? null, filters.limit + 1],
    );
    const hasMore = result.rows.length > filters.limit;
    const rows = result.rows.slice(0, filters.limit).map((row) => ({
      ...row,
      visitor_short_id: row.visitor_id.slice(0, 8),
      visitor_id: undefined,
      lead_captured: Boolean(row.lead_id),
      completed: Boolean(row.completed_at),
      duration_ms: Math.max(0, Math.round(number(row.duration_ms))),
    }));
    const last = rows.at(-1);
    return {
      range: rangeMeta(filters), rows,
      next_cursor: hasMore && last ? encodeCursor(last.started_at.toISOString(), last.session_id) : null,
    };
  }

  async sessionDetail(sessionId: string, includeQa: boolean, graceMinutes: number): Promise<Record<string, unknown> | null> {
    const session = await this.pool.query(
      `SELECT s.session_id,s.visitor_id,s.intent_cluster,s.landing_path,s.started_at,
        GREATEST(s.last_seen_at,COALESCE(activity.last_event_at,s.last_seen_at)) AS last_activity,
        COALESCE(s.completed_at,activity.form_completed_at) AS completed_at,
        s.last_step_id,s.last_step_index,s.experiment_id,s.variant_id,s.is_qa,l.lead_id,
        CASE WHEN s.completed_at IS NOT NULL OR activity.form_completed_at IS NOT NULL THEN 'COMPLETED'
          WHEN GREATEST(s.last_seen_at,COALESCE(activity.last_event_at,s.last_seen_at)) >= now()-make_interval(mins=>$3) THEN 'ACTIVE'
          WHEN l.lead_id IS NOT NULL THEN 'LEAD_CAPTURED' ELSE 'ABANDONED' END AS status
       FROM growth_v2.sessions s
       LEFT JOIN growth_v2.leads l ON l.session_id=s.session_id AND l.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT max(e.occurred_at) AS last_event_at,
           max(e.occurred_at) FILTER (WHERE e.event_name='form_completed') AS form_completed_at
         FROM growth_v2.events e WHERE e.session_id=s.session_id
       ) activity ON true
       WHERE s.session_id=$1 AND ($2::boolean OR NOT s.is_qa) AND s.deleted_at IS NULL`,
      [sessionId, includeQa, graceMinutes],
    );
    if (!session.rowCount) return null;
    const answers = await this.pool.query(
      `SELECT field_key,field_value,updated_at FROM growth_v2.lead_answers
       WHERE lead_id=$1 AND field_key <> 'first_name' AND cleared_at IS NULL ORDER BY field_key`,
      [session.rows[0].lead_id],
    );
    const attribution = await this.pool.query(
      `SELECT touch_kind,captured_at,landing_path,referrer,utm_source,utm_medium,utm_campaign,utm_term,
              utm_content,utm_id,gclid,gbraid,wbraid,gad_source,gad_campaignid,adgroupid,network,matchtype,device,geo,fbclid,msclkid,ttclid
       FROM growth_v2.attribution_touches WHERE session_id=$1 ORDER BY touch_kind`,
      [sessionId],
    );
    const events = await this.pool.query(
      `SELECT event_id,event_name,occurred_at,step_id,step_index,step_duration_ms,session_elapsed_ms,properties
       FROM growth_v2.events WHERE session_id=$1 ORDER BY occurred_at,event_id LIMIT 500`,
      [sessionId],
    );
    return {
      session: session.rows[0],
      answers: Object.fromEntries(answers.rows.map((row) => [row.field_key, row.field_value])),
      attribution: attribution.rows,
      timeline: events.rows,
      abandonment_grace_minutes: graceMinutes,
    };
  }

  async leads(filters: DashboardListFilters): Promise<Record<string, unknown>> {
    const cursor = decodeCursor(filters.cursor);
    const result = await this.pool.query(
      `WITH base AS (
       SELECT l.lead_id,l.session_id,l.status,l.created_at,l.updated_at,l.is_qa,l.intent_cluster,
        max(a.field_value) FILTER (WHERE a.field_key='event_type') AS event_type,
        max(a.field_value) FILTER (WHERE a.field_key='guest_range') AS guest_range,
        max(a.field_value) FILTER (WHERE a.field_key='service_style') AS service_style,
        max(a.field_value) FILTER (WHERE a.field_key='zip_code') AS zip_code,
        max(t.utm_source) FILTER (WHERE t.touch_kind='latest') AS source,
        max(t.utm_campaign) FILTER (WHERE t.touch_kind='latest') AS campaign,
        bool_or(s.completed_at IS NOT NULL OR EXISTS(
          SELECT 1 FROM growth_v2.events e WHERE e.session_id=s.session_id AND e.event_name='form_completed'
        )) AS completed,
        extract(epoch FROM (l.created_at-s.started_at))*1000 AS time_to_lead_ms
       FROM growth_v2.leads l JOIN growth_v2.sessions s ON s.session_id=l.session_id
       LEFT JOIN growth_v2.lead_answers a ON a.lead_id=l.lead_id AND a.cleared_at IS NULL
       LEFT JOIN growth_v2.attribution_touches t ON t.session_id=l.session_id
       WHERE s.started_at >= $1 AND s.started_at < $2 AND ($3::boolean OR NOT l.is_qa)
         AND l.deleted_at IS NULL
       GROUP BY l.lead_id,s.session_id,s.started_at
       ) SELECT * FROM base
       WHERE ($4::text IS NULL OR source=$4)
         AND ($5::text IS NULL OR campaign=$5)
         AND ($6::text IS NULL OR intent_cluster=$6)
         AND ($7::uuid IS NULL OR lead_id=$7)
         AND ($8::timestamptz IS NULL OR (created_at,lead_id)<($8::timestamptz,$9::uuid))
       ORDER BY created_at DESC,lead_id DESC LIMIT $10`,
      [filters.from, filters.to, filters.includeQa, filters.source, filters.campaign,
        filters.intentCluster, filters.exactId, cursor?.[0] ?? null, cursor?.[1] ?? null, filters.limit + 1],
    );
    const hasMore = result.rows.length > filters.limit;
    const rows = result.rows.slice(0, filters.limit).map((row) => ({
      ...row, phone_captured: true, time_to_lead_ms: Math.max(0, Math.round(number(row.time_to_lead_ms))),
    }));
    const last = rows.at(-1);
    return {
      range: rangeMeta(filters), rows,
      next_cursor: hasMore && last ? encodeCursor(last.created_at.toISOString(), last.lead_id) : null,
    };
  }

  async leadDetail(leadId: string, includeQa: boolean): Promise<Record<string, unknown> | null> {
    const lead = await this.pool.query(
      `SELECT lead_id,session_id,visitor_id,intent_cluster,status,is_qa,created_at,updated_at
       FROM growth_v2.leads WHERE lead_id=$1 AND ($2::boolean OR NOT is_qa) AND deleted_at IS NULL`,
      [leadId, includeQa],
    );
    if (!lead.rowCount) return null;
    const answers = await this.pool.query(
      `SELECT field_key,field_value,updated_at FROM growth_v2.lead_answers
       WHERE lead_id=$1 AND cleared_at IS NULL ORDER BY field_key`,
      [leadId],
    );
    return {
      lead: { ...lead.rows[0], phone_captured: true },
      answers: Object.fromEntries(answers.rows.map((row) => [row.field_key, row.field_value])),
    };
  }

  async attribution(range: ReportingRange): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `WITH cohort AS (
        SELECT s.session_id,s.completed_at,l.lead_id,t.utm_source,t.utm_medium,t.utm_campaign,t.utm_term,t.device,t.network,t.geo
        FROM growth_v2.sessions s
        LEFT JOIN growth_v2.leads l ON l.session_id=s.session_id AND l.deleted_at IS NULL
        LEFT JOIN growth_v2.attribution_touches t ON t.session_id=s.session_id AND t.touch_kind='latest'
        WHERE s.started_at >= $1 AND s.started_at < $2 AND ($3::boolean OR NOT s.is_qa) AND s.deleted_at IS NULL
      ), dimensions AS (
        SELECT c.session_id,c.lead_id,c.completed_at,d.dimension,d.value
        FROM cohort c CROSS JOIN LATERAL (VALUES
          ('utm_source',c.utm_source),('utm_medium',c.utm_medium),('utm_campaign',c.utm_campaign),
          ('utm_term',c.utm_term),('device',c.device),('network',c.network),('geo',c.geo)
        ) d(dimension,value)
      ) SELECT dimension,COALESCE(NULLIF(value,''),'(direct / unknown)') AS value,
        count(DISTINCT session_id)::int AS sessions,
        count(DISTINCT session_id) FILTER (WHERE lead_id IS NOT NULL)::int AS leads,
        count(DISTINCT session_id) FILTER (WHERE completed_at IS NOT NULL)::int AS completed
      FROM dimensions GROUP BY dimension,COALESCE(NULLIF(value,''),'(direct / unknown)')
      ORDER BY dimension,sessions DESC,value LIMIT 350`,
      [range.from, range.to, range.includeQa],
    );
    const groups: Record<string, unknown[]> = {};
    for (const row of result.rows) {
      const sessions = number(row.sessions);
      const item = {
        value: row.value, sessions, leads: number(row.leads), completed: number(row.completed),
        session_to_lead_conversion: percent(number(row.leads), sessions),
        session_to_complete_conversion: percent(number(row.completed), sessions),
      };
      (groups[row.dimension] ??= []).push(item);
    }
    return { range: rangeMeta(range), groups };
  }

  async close() {
    await this.pool.end();
  }
}
