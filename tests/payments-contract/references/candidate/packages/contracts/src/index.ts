export const roles = [
  "CLOSER",
  "SALES_LEADER",
  "MANAGER",
  "FINANCE",
  "OPERATIONS",
  "ADMIN",
] as const;
export type Role = (typeof roles)[number];

export const callStatuses = [
  "REQUESTED",
  "QUEUED",
  "INITIATED",
  "RINGING",
  "ANSWERED",
  "COMPLETED",
  "NO_ANSWER",
  "BUSY",
  "FAILED",
  "CANCELED",
  "VOICEMAIL",
  "BLOCKED_BY_POLICY",
] as const;
export type CallStatus = (typeof callStatuses)[number];

export type EventEnvelope<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
  id: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  recordedAt: string;
  actorId: string | null;
  source: string;
  correlationId: string;
  causationId: string | null;
  payloadVersion: number;
  idempotencyKey: string | null;
  payload: T;
};
export type SlaTimestamps = {
  leadReceivedAt: string;
  leadPersistedAt: string;
  closerAssignedAt: string | null;
  alertCreatedAt: string | null;
  callRequestedAt: string | null;
  providerAcceptedAt: string | null;
  ringingAt: string | null;
  answeredAt: string | null;
  completedAt: string | null;
  eventTimezone: string;
};
export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CSRF_REJECTED"
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED"
  | "VALIDATION_FAILED"
  | "POLICY_BLOCKED"
  | "REPLAY_REJECTED";

export * from "./payments.js";

/** Persisted, provider-neutral intent for Conversion-to-Logistic handoff. */
export type ConversionLogisticIntent = {
  eventId: string;
  idempotencyKey: string;
  sourceEventId: string | null;
  canonicalLeadId: string | null;
  workspaceId: string | null;
  sourceBoardId: string;
  sourceItemId: string;
  topic: "conversion.logistic.prepare";
  destinationBoardId: string;
  destinationGroupId: string;
  name: string;
  relationships: Readonly<
    Record<string, Readonly<Record<string, string>> | null>
  >;
  columns: Readonly<Record<string, unknown>>;
  unknowns: readonly string[];
  operationalState: {
    paymentStatus: null;
    chefStatus: null;
    timezone: null;
    readyForService: false;
    messaging: false;
    providerAssignment: null;
  };
};

/**
 * Lead automation contracts are deliberately provider-neutral. The database
 * timeline is authoritative; monday.com, Slack, Gemini and Telnyx are ports
 * around it.
 */
export const automationModes = ["shadow", "live"] as const;
export type AutomationMode = (typeof automationModes)[number];

export const leadWorkflowStates = [
  "ready",
  "initial_sent",
  "awaiting_reply",
  "followup_sent",
  "customer_replied",
  "qualified_interest",
  "quote_needed",
  "quote_sent",
  "closer_assigned",
  "lost",
  "opted_out",
  "booked",
  "human_review",
] as const;
export type LeadWorkflowState = (typeof leadWorkflowStates)[number];

export const factStates = [
  "confirmed",
  "stale",
  "unknown",
  "conflicting",
  "estimate",
] as const;
export type FactState = (typeof factStates)[number];

export const timelineDirections = ["INBOUND", "OUTBOUND", "SYSTEM"] as const;
export type TimelineDirection = (typeof timelineDirections)[number];

export const timelineChannels = [
  "SMS",
  "EMAIL",
  "CALL",
  "MONDAY",
  "SLACK",
  "CALCULATOR",
  "SYSTEM",
] as const;
export type TimelineChannel = (typeof timelineChannels)[number];

export const scheduledActionStates = [
  "pending",
  "running",
  "completed",
  "cancelled",
  "failed",
] as const;
export type ScheduledActionState = (typeof scheduledActionStates)[number];

export type SmsConsent = {
  status: "verified" | "missing" | "revoked" | "unknown";
  source: string | null;
  capturedAt: string | null;
  evidenceUrl: string | null;
};

export type AutomationLead = {
  /** Canonical Gourmet workspace. Every durable command is tenant-scoped. */
  workspaceId: string;
  id: string;
  /** The board is part of the CRM identity; an item id alone is not global. */
  mondayBoardId: string;
  mondayItemId: string;
  displayName: string;
  phoneE164: string | null;
  email: string | null;
  timezone: string | null;
  eventAt: string | null;
  eventType: string | null;
  venue: string | null;
  guestCount: number | null;
  mondayStatus: string;
  workflowState: LeadWorkflowState;
  score: number;
  assignedCloserId: string | null;
  automationEnabled: boolean;
  consent: SmsConsent;
  lastOutboundAt: string | null;
  nextActionAt: string | null;
};

export type LeadFact = {
  workspaceId: string;
  id: string;
  leadId: string;
  key: string;
  value: string | number | boolean | null;
  state: FactState;
  sourceEventId: string | null;
  confirmedAt: string | null;
};

export type LeadTimelineEvent = {
  workspaceId: string;
  id: string;
  leadId: string;
  occurredAt: string;
  type: string;
  direction: TimelineDirection;
  channel: TimelineChannel;
  body: string | null;
  sourceEventId: string | null;
  sourceUrl: string | null;
  deliveryStatus: string | null;
  metadata: Readonly<Record<string, unknown>>;
};

export type LeadQuote = {
  workspaceId: string;
  id: string;
  leadId: string;
  kind: "calculator_estimate" | "formal_quote";
  status:
    | "captured"
    | "draft"
    | "sent"
    | "viewed"
    | "accepted"
    | "declined"
    | "expired"
    | "void";
  calculatorUrl: string | null;
  quoteUrl: string | null;
  version: string | null;
  /** Currency minor units (for example, USD cents), never a floating price. */
  amountMinor: number | null;
  currency: string | null;
  scope: string | null;
  expiresAt: string | null;
  sentAt: string | null;
  sourceEventId: string | null;
  /** Required evidence when a formal quote has been sent. */
  sentEventId: string | null;
};

export type LeadContext = {
  lead: AutomationLead;
  facts: readonly LeadFact[];
  timeline: readonly LeadTimelineEvent[];
  recentTimeline: readonly LeadTimelineEvent[];
  /** Coverage of the bounded model excerpt; timeline itself remains complete. */
  /** Incomplete/over-limit contexts cannot draft or be approved. */
  contextSafety?: { reasonCodes: readonly string[]; complete: boolean };
  recentTimelineCoverage?: {
    totalEvents: number;
    includedEvents: number;
    omittedEvents: number;
    truncated: boolean;
  };
  quotes: readonly LeadQuote[];
  confirmedKeys: readonly string[];
  staleKeys: readonly string[];
  unknownKeys: readonly string[];
  conflictingKeys: readonly string[];
  summary: string;
  contextHash: string;
  compiledAt: string;
};

export type ScoreSignal = {
  code: string;
  value: number;
  eventIds: readonly string[];
};

export type AutomationRecommendation = {
  action: "send_sms" | "request_review" | "update_only" | "wait";
  draftSms: string | null;
  factsUsed: readonly string[];
  factsToConfirm: readonly string[];
  recommendedMondayStatus: string | null;
  scoreSignals: readonly ScoreSignal[];
  riskFlags: readonly string[];
  nextActionType: string | null;
  nextActionAt: string | null;
  reason: string;
  contextHash: string;
};

export type AutomationDecision = {
  route: "AUTO_SEND" | "REVIEW" | "SUPPRESS" | "WAIT";
  workflowState: LeadWorkflowState;
  score: number;
  scoreSignals: readonly ScoreSignal[];
  reasonCodes: readonly string[];
};

export type ScheduledAutomationAction = {
  workspaceId: string;
  id: string;
  leadId: string;
  actionType:
    | "initial_outreach"
    | "follow_up"
    | "followup_review"
    | "slack_escalation"
    | "context_refresh"
    | "monday_sync"
    | "email_quote";
  dueAt: string;
  state: ScheduledActionState;
  policyVersion: string;
  contextHash: string;
  idempotencyKey: string;
  reason: string;
  createdAt: string;
  /** Non-null only while a worker owns a durable action lease. */
  leaseToken: string | null;
};

export type OutboundSms = {
  workspaceId: string;
  id: string;
  leadId: string;
  body: string;
  status:
    | "draft"
    | "queued"
    | "sending"
    | "accepted"
    | "delivered"
    | "failed"
    | "suppressed"
    | "cancelled";
  providerMessageId: string | null;
  /** Stable across retries and passed unchanged to the carrier. */
  idempotencyKey: string;
  policyVersion: string;
  contextHash: string;
  approvalId: string | null;
  createdAt: string;
  sentAt: string | null;
};

/** Telnyx states are retained verbatim so delivery uncertainty is never relabelled as a hard failure. */
export type TelnyxOutboundSmsLifecycleStatus =
  | "sent"
  | "delivered"
  | "delivery_failed"
  | "delivery_unconfirmed";

/**
 * A signed, normalized outbound carrier event. Workspace and lead identity are
 * resolved by first-party storage, never selected from the Telnyx payload.
 */
export type TelnyxOutboundSmsLifecycleEvent = {
  workspaceId: string;
  eventId: string;
  /** Null until a pending signed receipt can be correlated to a sent message. */
  leadId: string | null;
  providerMessageId: string;
  to: string;
  status: TelnyxOutboundSmsLifecycleStatus;
  occurredAt: string;
  statusAt: string;
  /** SHA-256 of the exact provider-signed raw request body. */
  payloadDigest: string;
  raw: Readonly<Record<string, unknown>>;
};

export type OutboundSmsLifecycleApplyResult = {
  duplicate: boolean;
  applied: boolean;
  pendingCorrelation: boolean;
  conflict: boolean;
  leadId: string | null;
  messageId: string | null;
  messageStatus: OutboundSms["status"] | null;
};

export type ReviewRequest = {
  workspaceId: string;
  id: string;
  leadId: string;
  draftSms: string | null;
  contextHash: string;
  reasonCodes: readonly string[];
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  /** Canonical first-party user id that made a terminal review decision. */
  reviewerId: string | null;
  expiresAt: string;
  createdAt: string;
};

export type MondayWebhookEvent = {
  eventId: string;
  boardId: string;
  itemId: string;
  occurredAt: string;
  raw: Readonly<Record<string, unknown>>;
};

export type TelnyxInboundSmsEvent = {
  workspaceId: string;
  eventId: string;
  leadId: string;
  providerMessageId: string;
  from: string;
  body: string;
  occurredAt: string;
  raw: Readonly<Record<string, unknown>>;
};

export * from "./gemini-spend.js";
