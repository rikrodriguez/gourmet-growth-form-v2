export type AreaId = 'sales' | 'coordination' | 'kitchen' | 'finance' | 'direction';
export type FunctionId = 'sales' | 'proposals' | 'coordination' | 'logistics' | 'suppliers' | 'finance' | 'quality' | 'marketing' | 'talent';
export type WorkStatus = 'queued' | 'running' | 'awaiting_approval' | 'blocked' | 'completed' | 'failed' | 'stale';
export type DataMode = 'demo' | 'live' | 'offline';
export type Evidence = { source: string; at: string; simulated: boolean; reference: string };
export type OfficeTask = { id: string; area: AreaId; functionId: FunctionId; title: string; detail: string; status: WorkStatus; evidence: Evidence };
export type OfficeResult = { id: string; area: AreaId; functionId: FunctionId; title: string; detail: string; evidence: Evidence };
export type OfficeApproval = { id: string; area: AreaId; functionId: FunctionId; title: string; body: string; recipient: string; account: string; attachments: string[]; channel: string; revision: number; digest: string; status: 'pending' | 'approved_demo' | 'rejected_demo' | 'cancelled_demo'; evidence: Evidence };
export type OfficeMessage = { id: string; area: AreaId; functionId: FunctionId; author: string; text: string; evidence: Evidence };
export type OfficeHistory = { id: string; functionId: FunctionId; title: string; detail: string; status: WorkStatus; evidence: Evidence };
export type OfficeCase = {
  id: string; title: string; subtitle: string; evidence: Evidence;
  payment: 'verified' | 'pending' | 'unknown'; paymentEvidence: Evidence | null;
  supplier: 'accepted' | 'pending' | 'unknown'; supplierEvidence: Evidence | null;
  capturedAt: string; attemptedAt: string | null; connectedAt: string | null;
  humanContactVerified: boolean; callEvidence: Evidence | null;
  closerAvailable: boolean | null; assignment: 'assigned' | 'queued' | 'unknown';
  saleClosed: boolean | null; history: OfficeHistory[];
  tasks: OfficeTask[]; results: OfficeResult[]; approvals: OfficeApproval[]; messages: OfficeMessage[];
};
export type OfficeSnapshot = { mode: DataMode; asOf: string; cases: OfficeCase[]; note: string; hasMore?: boolean; outboundEffects: 0; mondayWrites: 0 };
export type OfficeCommand = { idempotencyKey: string; caseId: string; functionId: FunctionId; action: 'draft' | 'chat' | 'approve' | 'reject' | 'cancel' | 'revise'; text?: string; approvalId?: string; revision?: number; digest?: string };

export const STATUS_LABELS: Record<WorkStatus, string> = {
  queued: 'En cola', running: 'En curso', awaiting_approval: 'Por aprobar', blocked: 'Bloqueado',
  completed: 'Completado', failed: 'Falló', stale: 'Desactualizado',
};
