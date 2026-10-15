import type { AutomationRecommendation } from "./index.js";

/** Synthetic fixtures only. No contract or stored row authorizes real consumption. */
export type SyntheticGeminiSpendConfiguration = {
  scope: "synthetic-fixture";
  authorized: true;
  authorizationId: string;
  budgetId: string;
  workspaceId: string;
  model: string;
  currency: string;
  budgetMicros: number;
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  tariffVersion: string;
  maxOutputTokens: number;
  expiresAtEpochMs: number;
};
export type SyntheticSpendInvocation = {
  workspaceId: string;
  model: string;
  operationId: string;
  fingerprint: string;
  requestBytes: number;
};
export type SyntheticSpendReservation =
  | { disposition: "new"; ownerToken: string; reservedMicros: number }
  | { disposition: "succeeded"; result: AutomationRecommendation }
  | { disposition: "in_progress" | "uncertain" };
export interface SyntheticGeminiSpendStore {
  readonly scope: "synthetic-fixture";
  readAuthorization(
    workspaceId: string,
    model: string,
  ): Promise<Readonly<SyntheticGeminiSpendConfiguration>>;
  reserve(
    invocation: SyntheticSpendInvocation,
  ): Promise<SyntheticSpendReservation>;
  begin(operationId: string, ownerToken: string): Promise<boolean>;
  complete(
    operationId: string,
    ownerToken: string,
    result: AutomationRecommendation,
  ): Promise<void>;
  fail(operationId: string, ownerToken: string): Promise<void>;
}
export interface SyntheticGeminiSpendGate {
  readonly scope: "synthetic-fixture";
  outputTokenCeiling(
    workspaceId: string,
    model: string,
  ): number | Promise<number>;
  run(
    invocation: SyntheticSpendInvocation,
    invoke: () => Promise<AutomationRecommendation>,
  ): Promise<AutomationRecommendation>;
}
export const isSyntheticSpendIdentifier = (s: unknown): s is string =>
  typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s);
const positiveInteger = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
export function requireSyntheticSpendConfiguration(
  value: unknown,
  now: number,
): Readonly<SyntheticGeminiSpendConfiguration> {
  const c = value as SyntheticGeminiSpendConfiguration | null;
  if (
    !c ||
    c.scope !== "synthetic-fixture" ||
    c.authorized !== true ||
    ![
      c.authorizationId,
      c.budgetId,
      c.workspaceId,
      c.model,
      c.tariffVersion,
    ].every(isSyntheticSpendIdentifier) ||
    typeof c.currency !== "string" ||
    !/^[A-Z]{3}$/.test(c.currency) ||
    ![
      c.budgetMicros,
      c.inputMicrosPerMillionTokens,
      c.outputMicrosPerMillionTokens,
      c.maxOutputTokens,
      c.expiresAtEpochMs,
    ].every(positiveInteger) ||
    c.maxOutputTokens > 8192 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    c.expiresAtEpochMs <= now
  ) {
    throw new Error(
      "Synthetic Gemini spend authorization/configuration is invalid or expired",
    );
  }
  return c;
}
export function reserveSyntheticSpendMicros(
  c: Readonly<SyntheticGeminiSpendConfiguration>,
  invocation: SyntheticSpendInvocation,
): bigint {
  if (
    invocation.workspaceId !== c.workspaceId ||
    invocation.model !== c.model ||
    !isSyntheticSpendIdentifier(invocation.operationId) ||
    !/^[a-f0-9]{64}$/.test(invocation.fingerprint) ||
    !positiveInteger(invocation.requestBytes) ||
    invocation.requestBytes > 131072
  )
    throw new Error(
      "Synthetic spend invocation is invalid or outside authorization",
    );
  const million = 1_000_000n;
  const ceil = (n: bigint) => (n + million - 1n) / million;
  return (
    ceil(
      BigInt(invocation.requestBytes) * BigInt(c.inputMicrosPerMillionTokens),
    ) + ceil(BigInt(c.maxOutputTokens) * BigInt(c.outputMicrosPerMillionTokens))
  );
}
export function isSyntheticSpendResult(
  value: unknown,
): value is AutomationRecommendation {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const strings = (x: unknown) =>
    Array.isArray(x) && x.every((v) => typeof v === "string");
  const nullable = (x: unknown) => typeof x === "string" || x === null;
  return (
    typeof r.action === "string" &&
    ["send_sms", "request_review", "update_only", "wait"].includes(r.action) &&
    typeof r.reason === "string" &&
    typeof r.contextHash === "string" &&
    /^[a-f0-9]{64}$/.test(r.contextHash) &&
    [
      r.draftSms,
      r.recommendedMondayStatus,
      r.nextActionType,
      r.nextActionAt,
    ].every(nullable) &&
    [r.factsUsed, r.factsToConfirm, r.riskFlags].every(strings) &&
    Array.isArray(r.scoreSignals) &&
    r.scoreSignals.every(
      (v) =>
        v &&
        typeof v === "object" &&
        typeof v.code === "string" &&
        typeof v.value === "number" &&
        Number.isFinite(v.value) &&
        strings(v.eventIds),
    )
  );
}
