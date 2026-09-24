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
  leadDetail(leadId: string, includeQa: boolean): Promise<Record<string, unknown> | null>;
  attribution(range: ReportingRange): Promise<Record<string, unknown>>;
  crmHealth(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
