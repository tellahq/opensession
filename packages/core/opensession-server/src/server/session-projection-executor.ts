import {
  isRetryableSessionCommandError,
  sessionGatewayCommand,
  type GatewayCommandOperation,
} from "./session-kernel";
import { SessionKernelQuarantinedError } from "./session-kernel/actor-client";

// Bounded retry for saturation-class kernel errors. Under concurrent load the
// actor service sheds work with retryable "lane/mailbox is full" errors, and
// the client deliberately retries only reads — so a transcript projection hit
// by a momentary burst used to fail outright and mark the session degraded
// (measured: 100 concurrent sessions rejected 48% of appends). Admission and
// settlement are both idempotent by request id (`requestGatewayCommand`
// replays a completed receipt, `completeGatewayCommand` returns the stored
// result), so a bounded retry here is safe and converts a burst into a short
// delay. Total worst-case added wait is ~1.6s, far below the actor client's
// 15s deadline.
const KERNEL_SATURATION_RETRY_ATTEMPTS = 6;
const KERNEL_SATURATION_RETRY_BASE_MS = 50;
const KERNEL_SATURATION_RETRY_MAX_MS = 800;

/** Exported for tests. Returns the call result plus whether any retry ran —
 *  callers use `retried` to accept an `in_progress` admission replay that our
 *  own ambiguous earlier attempt committed. */
export async function retryOnKernelSaturation<T>(
  label: string,
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ result: T; retried: boolean }> {
  let delayMs = KERNEL_SATURATION_RETRY_BASE_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return { result: await call(), retried: attempt > 1 };
    } catch (error) {
      if (
        attempt >= KERNEL_SATURATION_RETRY_ATTEMPTS ||
        !isRetryableSessionCommandError(error)
      )
        throw error;
      console.warn(
        `[session-projection] ${label} hit a retryable kernel error (attempt ${attempt}/${KERNEL_SATURATION_RETRY_ATTEMPTS}); retrying:`,
        error instanceof Error ? error.message : String(error),
      );
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, KERNEL_SATURATION_RETRY_MAX_MS);
    }
  }
}

const projectionState = globalThis as typeof globalThis & {
  __sessionProjectionTails?: Map<string, Promise<void>>;
};

function serializeSessionProjection<T>(
  sessionId: string,
  project: () => Promise<T>,
): Promise<T> {
  const tails = (projectionState.__sessionProjectionTails ??= new Map());
  const prior = tails.get(sessionId) ?? Promise.resolve();
  const result = prior.then(project);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(sessionId, tail);
  void tail.finally(() => {
    if (tails.get(sessionId) === tail) tails.delete(sessionId);
  });
  return result;
}

/**
 * Execute one destination mutation after actor admission. The physical mutation
 * runs on the gateway thread, never in the actor Worker, while admission and
 * exact completion remain durable and ordered with other session projections.
 */
export function executeDestinationIdempotentSessionProjection<T>(
  sessionId: string,
  requestId: string,
  operation: "transcript_destination_append",
  identity: unknown,
  mutate: () => T | Promise<T>,
): Promise<T> {
  return serializeSessionProjection(sessionId, async () => {
    const { result: plan, retried } = await retryOnKernelSaturation(
      `${operation} admission`,
      () =>
        sessionGatewayCommand({
          op: "request",
          sessionId,
          requestId,
          operation,
          identity,
        }),
    );
    if (plan.status === "completed") return plan.result as T;
    // `in_progress` after our own ambiguous admission retry means the earlier
    // attempt committed; the destination write below is idempotent by append
    // id, so executing is the same as the non-retried admitted path.
    if (plan.status === "in_progress" && !retried)
      throw new Error(
        `Destination command ${requestId} is already in progress`,
      );
    let physicalFinished = false;
    try {
      const result = await mutate();
      physicalFinished = true;
      return (
        await retryOnKernelSaturation(`${operation} settlement`, () =>
          sessionGatewayCommand({
            op: "complete",
            sessionId,
            requestId,
            operation,
            result,
          }),
        )
      ).result as T;
    } catch (error) {
      if (!physicalFinished) {
        try {
          await retryOnKernelSaturation(`${operation} failure settlement`, () =>
            sessionGatewayCommand({
              op: "fail",
              sessionId,
              requestId,
              operation,
              error: error instanceof Error ? error.message : String(error),
              retryable: true,
            }),
          );
        } catch (settleError) {
          // The original physical/admission error stays primary; the durable
          // receipt remains `processing` and boot recovery reconciles it.
          console.warn(
            `[session-projection] ${operation} failure settlement did not commit for ${sessionId}:`,
            settleError instanceof Error
              ? settleError.message
              : String(settleError),
          );
        }
      }
      throw error;
    }
  });
}

export function executeSessionProjection<T>(
  sessionId: string,
  operation: GatewayCommandOperation,
  mutate: () => T | Promise<T>,
): Promise<T> {
  return serializeSessionProjection(sessionId, async () => {
    const requestId = `${operation}:${crypto.randomUUID()}`;
    const { result: plan, retried } = await retryOnKernelSaturation(
      `${operation} admission`,
      () =>
        sessionGatewayCommand({
          op: "request",
          sessionId,
          requestId,
          operation,
        }),
    );
    // The request id is minted here and never shared, so `in_progress` can
    // only be our own ambiguous earlier attempt whose admission committed —
    // nothing has executed yet, so proceeding is the normal admitted path.
    const admitted =
      plan.status === "execute" || (retried && plan.status === "in_progress");
    if (!admitted) throw new Error(`Unexpected duplicate ${operation} command`);
    let physicalFinished = false;
    try {
      const result = await mutate();
      physicalFinished = true;
      return (
        await retryOnKernelSaturation(`${operation} settlement`, () =>
          sessionGatewayCommand({
            op: "complete",
            sessionId,
            requestId,
            operation,
            result,
          }),
        )
      ).result as T;
    } catch (error) {
      if (!physicalFinished) {
        try {
          await retryOnKernelSaturation(`${operation} failure settlement`, () =>
            sessionGatewayCommand({
              op: "fail",
              sessionId,
              requestId,
              operation,
              error: error instanceof Error ? error.message : String(error),
              retryable: false,
            }),
          );
        } catch (settleError) {
          console.warn(
            `[session-projection] ${operation} failure settlement did not commit for ${sessionId}:`,
            settleError instanceof Error
              ? settleError.message
              : String(settleError),
          );
        }
      }
      throw error;
    }
  });
}

/**
 * Keep reversible archive visibility available while actor-owned state is
 * quarantined. Archiving neither releases the safety fence nor retries the
 * uncertain action, and the archive registry already supports idempotent
 * writes. Every other projection failure still fails closed.
 */
export async function executeArchiveOverrideProjection<T>(
  sessionId: string,
  mutate: () => T | Promise<T>,
  project: typeof executeSessionProjection = executeSessionProjection,
): Promise<T> {
  let mutation: Promise<T> | undefined;
  const mutateOnce = () => (mutation ??= Promise.resolve().then(mutate));
  try {
    return await project(sessionId, "archive_override", mutateOnce);
  } catch (error) {
    if (
      !(error instanceof SessionKernelQuarantinedError) ||
      error.sessionId !== sessionId
    )
      throw error;
    return mutateOnce();
  }
}
