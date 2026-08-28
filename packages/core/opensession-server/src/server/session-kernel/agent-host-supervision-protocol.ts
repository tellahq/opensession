import {
  AGENT_HOST_SUPERVISION_AUDIENCE,
  AGENT_HOST_SUPERVISION_PURPOSE,
  AGENT_HOST_SUPERVISION_VERSION,
  decodeAgentHostSupervisionAuthorityV2,
  type AgentHostSupervisionAuthorityV2,
} from "@tellahq/opensession-protocol/agent-host";
import type { SignedAgentHostSupervisionEnvelopeV1 } from "@tellahq/opensession-protocol/agent-host-supervision";
import { decodeExecutorId } from "@tellahq/opensession-protocol/executor";

export type AgentHostPlanRegistration = {
  op: "register_plan";
  registrationId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generation: number;
  planHash: string;
};

/** Untrusted V3 claim intent. Issuer metadata is intentionally absent. */
export type AgentHostSupervisionClaim = {
  op: "claim";
  claimId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generation: number;
  planHash: string;
  hostId: string;
  hostGeneration: number;
  hostIncarnation: string;
  hostChallenge: string;
};

export type AgentHostSupervisionRequest =
  AgentHostPlanRegistration | AgentHostSupervisionClaim;
export type AgentHostPlanRegistrationResult =
  | { accepted: true; replayed: boolean }
  | {
      accepted: false;
      reason: "stale_run" | "terminal_run" | "invalid_plan" | "plan_mismatch";
    };
export type AgentHostSupervisionReceipt = {
  format: "signed_v1";
  authority: AgentHostSupervisionAuthorityV2;
  /** Preserved v26-compatible standard-base64 representation. */
  authorityBytes: string;
  authorityHash: string;
  keyId: string;
  envelope: SignedAgentHostSupervisionEnvelopeV1;
};
export type AgentHostSupervisionResult =
  | { accepted: true; replayed: boolean; receipt: AgentHostSupervisionReceipt }
  | {
      accepted: false;
      reason:
        | "stale_run"
        | "terminal_run"
        | "invalid_claim"
        | "claim_mismatch"
        | "challenge_reused"
        | "nonce_reused"
        | "stale_host"
        | "plan_unregistered"
        | "plan_mismatch"
        | "receipt_capacity"
        | "issuer_unavailable";
    };

export type AgentHostSupervisionIssuerContext = {
  readonly kernelServiceEpoch: string;
  readonly keyId: string;
  readonly leaseMs: number;
  readonly now: () => number;
  readonly nonce: () => string;
  readonly sign: (
    canonicalAuthorityBytes: Uint8Array,
    nowMs: number,
  ) => SignedAgentHostSupervisionEnvelopeV1;
};

const PLAN_KEYS = [
  "op",
  "registrationId",
  "sessionId",
  "runId",
  "turnId",
  "generation",
  "planHash",
] as const;
const PLAN_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const HOST_INCARNATION_RE = /^[A-Za-z0-9._:-]{8,256}$/;
const SUPERVISION_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

export function decodeAgentHostPlanRegistration(
  value: unknown,
): AgentHostPlanRegistration | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const plan = value as Record<string, unknown>;
  if (
    Object.keys(plan).length !== PLAN_KEYS.length ||
    Object.keys(plan).some((key) => !PLAN_KEYS.includes(key as never)) ||
    plan.op !== "register_plan" ||
    !decodeExecutorId(plan.registrationId) ||
    !decodeExecutorId(plan.sessionId) ||
    !decodeExecutorId(plan.runId) ||
    !decodeExecutorId(plan.turnId) ||
    !Number.isSafeInteger(plan.generation) ||
    (plan.generation as number) < 0 ||
    typeof plan.planHash !== "string" ||
    !PLAN_HASH_RE.test(plan.planHash)
  )
    return undefined;
  return plan as AgentHostPlanRegistration;
}

const CLAIM_KEYS = [
  "op",
  "claimId",
  "sessionId",
  "runId",
  "turnId",
  "generation",
  "planHash",
  "hostId",
  "hostGeneration",
  "hostIncarnation",
  "hostChallenge",
] as const;

/** Exact V3 hard cut. Any former gateway-controlled issuer field is rejected. */
export function decodeAgentHostSupervisionClaim(
  value: unknown,
): AgentHostSupervisionClaim | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const claim = value as Record<string, unknown>;
  if (
    Object.keys(claim).length !== CLAIM_KEYS.length ||
    Object.keys(claim).some((key) => !CLAIM_KEYS.includes(key as never)) ||
    claim.op !== "claim" ||
    !decodeExecutorId(claim.claimId) ||
    !decodeExecutorId(claim.sessionId) ||
    !decodeExecutorId(claim.runId) ||
    !decodeExecutorId(claim.turnId) ||
    !Number.isSafeInteger(claim.generation) ||
    (claim.generation as number) < 0 ||
    typeof claim.planHash !== "string" ||
    !PLAN_HASH_RE.test(claim.planHash) ||
    !decodeExecutorId(claim.hostId) ||
    !Number.isSafeInteger(claim.hostGeneration) ||
    (claim.hostGeneration as number) < 1 ||
    typeof claim.hostIncarnation !== "string" ||
    !HOST_INCARNATION_RE.test(claim.hostIncarnation) ||
    typeof claim.hostChallenge !== "string" ||
    !SUPERVISION_TOKEN_RE.test(claim.hostChallenge)
  )
    return undefined;
  return claim as AgentHostSupervisionClaim;
}

export function authorityFromAgentHostSupervisionClaim(
  claim: AgentHostSupervisionClaim,
  issuer: Readonly<{
    supervisorEpoch: number;
    kernelServiceEpoch: string;
    issuedAtMs: number;
    expiresAtMs: number;
    nonce: string;
    keyId: string;
  }>,
): AgentHostSupervisionAuthorityV2 | undefined {
  return decodeAgentHostSupervisionAuthorityV2(
    {
      version: AGENT_HOST_SUPERVISION_VERSION,
      fence: {
        sessionId: claim.sessionId,
        runId: claim.runId,
        turnId: claim.turnId,
        generation: claim.generation,
      },
      planHash: claim.planHash,
      hostId: claim.hostId,
      hostGeneration: claim.hostGeneration,
      hostIncarnation: claim.hostIncarnation,
      supervisorEpoch: issuer.supervisorEpoch,
      kernelServiceEpoch: issuer.kernelServiceEpoch,
      hostChallenge: claim.hostChallenge,
      audience: AGENT_HOST_SUPERVISION_AUDIENCE,
      purpose: AGENT_HOST_SUPERVISION_PURPOSE,
      issuedAtMs: issuer.issuedAtMs,
      expiresAtMs: issuer.expiresAtMs,
      nonce: issuer.nonce,
      keyId: issuer.keyId,
    },
    issuer.issuedAtMs,
  );
}
