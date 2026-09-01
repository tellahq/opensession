import type { PrCheck } from "./types";

export type CheckVisual =
  | "success"
  | "failure"
  | "pending"
  | "skipped"
  | "neutral";

export function checkStatusMeta(check: PrCheck): {
  kind: CheckVisual;
  label: string;
} {
  const running = check.status !== "COMPLETED" && check.status !== "";
  if (
    running ||
    check.conclusion === "PENDING" ||
    check.conclusion === "EXPECTED"
  )
    return { kind: "pending", label: running ? "Running" : "Queued" };
  switch (check.conclusion) {
    case "SUCCESS":
      return { kind: "success", label: "Succeeded" };
    case "FAILURE":
      return { kind: "failure", label: "Failed" };
    case "TIMED_OUT":
      return { kind: "failure", label: "Timed out" };
    case "ERROR":
      return { kind: "failure", label: "Error" };
    case "ACTION_REQUIRED":
      return { kind: "failure", label: "Action required" };
    case "CANCELLED":
      return { kind: "neutral", label: "Cancelled" };
    case "SKIPPED":
      return { kind: "skipped", label: "Skipped" };
    case "NEUTRAL":
      return { kind: "neutral", label: "Neutral" };
    default:
      return { kind: "neutral", label: check.conclusion || "Pending" };
  }
}

export function checkToneClass(kind: CheckVisual): string {
  switch (kind) {
    case "success":
      return "text-green";
    case "failure":
      return "text-red";
    case "pending":
      return "text-yellow";
    default:
      return "text-dim";
  }
}
