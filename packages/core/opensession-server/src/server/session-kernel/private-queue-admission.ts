import { assertPersonalAttachmentsAbsent } from "../personal-image-admission";
import { samePersonalRepoBinding } from "../personal-repo-runtime";
import type { PrivateActorFence } from "./private-access";
import type { DeliveryActorRequest } from "./delivery-protocol";
import type { DurableDeliveryState } from "./store";

export type PrivateQueueAdmission = Omit<PrivateActorFence, "consumer">;

/** Runs inside the actor commit fence. Caller-supplied stamps never confer authority. */
export function stampPrivateQueueRequest(
  request: DeliveryActorRequest,
  source: PrivateActorFence,
  existing: DurableDeliveryState,
): DeliveryActorRequest {
  const previous = [
    ...existing.queued,
    ...existing.steered,
    ...existing.pendingSteers.map((p) => p.item),
    ...((existing.dispatch as { items?: unknown[] } | undefined)?.items ?? []),
  ];
  const validate = (admission: unknown) => {
    const a = admission as PrivateQueueAdmission | undefined;
    if (
      !a ||
      a.sourceSessionId !== source.sourceSessionId ||
      a.owner !== source.owner ||
      a.incarnation !== source.incarnation ||
      a.generation !== source.generation ||
      !a.binding ||
      !source.binding ||
      !samePersonalRepoBinding(a.binding, source.binding)
    )
      throw new Error("Private queue original admission authority changed");
  };
  const stamp = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid private queue item");
    const item = value as Record<string, unknown>;
    assertPersonalAttachmentsAbsent({ ...item, personalRepo: true });
    if (typeof item.id !== "string" || !item.id)
      throw new Error("Private queue item id required");
    const old = previous.find(
      (value) =>
        value &&
        typeof value === "object" &&
        "id" in value &&
        value.id === item.id,
    ) as Record<string, unknown> | undefined;
    if (old) assertPersonalAttachmentsAbsent({ ...old, personalRepo: true });
    let admission = old?.privateAdmission;
    if (!old) {
      if (source.consumer)
        throw new Error("Private run cannot mint queue admission");
      if (!source.binding) throw new Error("Private queue binding unavailable");
      admission = {
        sourceSessionId: source.sourceSessionId,
        owner: source.owner,
        incarnation: source.incarnation,
        generation: source.generation,
        binding: source.binding,
      } satisfies PrivateQueueAdmission;
    }
    if (!admission)
      throw new Error("Private queue original admission unavailable");
    validate(admission);
    return { ...item, privateAdmission: admission };
  };
  switch (request.op) {
    case "claim_next_dispatch":
      for (const item of existing.queued) stamp(item);
      return request;
    case "enqueue":
      return { ...request, item: stamp(request.item) };
    case "promote_queued":
    case "prepare_steer":
      return {
        ...request,
        item: stamp(
          request.item ??
            previous.find(
              (item) =>
                item &&
                typeof item === "object" &&
                "id" in item &&
                item.id === request.itemId,
            ),
        ),
      };
    case "claim_dispatch":
    case "requeue_steers":
      return { ...request, items: request.items.map(stamp) };
    case "set": {
      if (request.slot === "dispatch") {
        const value = request.value as { items?: unknown[] };
        if (!value || !Array.isArray(value.items))
          throw new Error("Invalid private dispatch");
        return {
          ...request,
          value: { ...value, items: value.items.map(stamp) },
        };
      }
      if (!Array.isArray(request.value))
        throw new Error("Invalid private queue");
      return { ...request, value: request.value.map(stamp) };
    }
    default:
      return request;
  }
}
