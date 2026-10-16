export type StaffRole = 'admin' | 'viewer';

export type StaffUser = {
  staffUserId: string;
  email: string;
  passwordHash: string;
  role: StaffRole;
  enabled: boolean;
};

export type AuthenticatedStaff = Omit<StaffUser, 'passwordHash'> & {
  staffSessionId: string;
  expiresAt: string;
};

export type DashboardLeadDetail = {
  lead: Record<string, unknown> & { lead_id: string; monday_item_id: string | null };
  answers: Record<string, unknown>;
};

/** Read projection of existing SQL authority. No document or approval authority. */
export type StaffLeadReadContext = {
  staff_user_id: string; staff_session_id: string; role: StaffRole; expires_at: string;
  lead_id: string; monday_item_id: string | null;
  can_read: true; can_approve_document: false;
  document_status: 'unlinked'; event_id: null; proposal_id: null;
};

export type ReportingRange = {
  from: Date;
  to: Date;
  label: string;
  timezone: 'America/Los_Angeles';
  includeQa: boolean;
};

export type SessionStatus = 'ACTIVE' | 'LEAD_CAPTURED' | 'COMPLETED' | 'ABANDONED';

export type DashboardListFilters = ReportingRange & {
  limit: number;
  cursor: string | null;
  status: SessionStatus | null;
  step: string | null;
  source: string | null;
  campaign: string | null;
  intentCluster: string | null;
  exactId: string | null;
};

export type ExperimentReportFilters = ReportingRange & {
  intentCluster: string | null;
  experimentId: string | null;
  variantId: string | null;
};

export interface DashboardStore {
  health(): Promise<void>;
  findStaffByEmail(email: string): Promise<StaffUser | null>;
  rotateStaffSession(staffUserId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  authenticateStaff(tokenHash: string): Promise<AuthenticatedStaff | null>;
  revokeStaffSession(tokenHash: string): Promise<void>;
  recordLogin(staffUserId: string): Promise<void>;
  overview(range: ReportingRange, graceMinutes: number): Promise<Record<string, unknown>>;
  funnel(range: ReportingRange): Promise<Record<string, unknown>>;
  sessions(filters: DashboardListFilters, graceMinutes: number): Promise<Record<string, unknown>>;
  sessionDetail(sessionId: string, includeQa: boolean, graceMinutes: number): Promise<Record<string, unknown> | null>;
  leads(filters: DashboardListFilters): Promise<Record<string, unknown>>;
  leadDetail(leadId: string, includeQa: boolean): Promise<DashboardLeadDetail | null>;
  attribution(range: ReportingRange): Promise<Record<string, unknown>>;
  experiments(filters: ExperimentReportFilters): Promise<Record<string, unknown>>;
  crmHealth(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
