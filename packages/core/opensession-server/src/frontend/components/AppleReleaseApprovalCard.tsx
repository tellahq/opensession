import { useEffect, useState } from "react";
import {
  approveAppleRelease,
  fetchAppleReleaseApprovals,
  type AppleReleaseApprovals,
} from "../lib/api/apple-mobile";
import { Button } from "../ui/button";
import { AppleReleaseRequestDetails } from "./AppleReleaseRequest";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; approvals: AppleReleaseApprovals }
  | { kind: "approved" };

async function load(): Promise<State> {
  try {
    return { kind: "loaded", approvals: await fetchAppleReleaseApprovals() };
  } catch (cause) {
    return {
      kind: "error",
      message:
        cause instanceof Error
          ? cause.message
          : "Could not load Apple release approvals",
    };
  }
}

/**
 * Approve an Apple release plan where the agent made it. The card reads the
 * plan from the server's signed approval list, never from the tool output, and
 * approval uses the same allowlisted route as Settings. Execution still needs
 * the agent to run the plan in a later turn.
 */
export function AppleReleaseApprovalCard({ planId }: { planId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void load().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [planId]);

  async function approve() {
    if (approving) return;
    setApproving(true);
    setError(null);
    try {
      await approveAppleRelease(planId);
      setState({ kind: "approved" });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not approve Apple release",
      );
    }
    setApproving(false);
  }

  if (state.kind === "loading") return null;

  let body: React.ReactNode;
  if (state.kind === "error") {
    body = <p className="m-0 text-meta text-red">{state.message}</p>;
  } else if (state.kind === "approved") {
    body = (
      <p className="m-0 text-supporting text-fg">
        Approved. Tell the agent to run the plan.
      </p>
    );
  } else if (!state.approvals.authenticated) {
    body = (
      <p className="m-0 text-supporting text-dim">
        Sign in to approve this release.
      </p>
    );
  } else if (!state.approvals.allowed) {
    body = (
      <p className="m-0 text-supporting text-dim">
        Waiting for someone on the release allowlist to approve it.
      </p>
    );
  } else {
    const request = state.approvals.requests.find(
      (item) => item.planId === planId,
    );
    body = request ? (
      <>
        <AppleReleaseRequestDetails request={request} />
        {error && (
          <p className="m-0 text-meta text-red" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end">
          <Button
            variant="primary"
            size="lg"
            className="phone:min-h-11"
            disabled={approving}
            onClick={() => void approve()}
          >
            {approving ? "Approving…" : "Approve"}
          </Button>
        </div>
      </>
    ) : (
      <p className="m-0 text-supporting text-dim">
        This plan is no longer waiting for approval.
      </p>
    );
  }

  return (
    <section
      className="mb-3 mt-1.5 flex flex-col gap-3 rounded-xl bg-raised p-4 [corner-shape:var(--cs)]"
      aria-label="Apple release approval"
    >
      <span className="text-label font-semibold text-dim">
        Apple release approval
      </span>
      {body}
    </section>
  );
}
