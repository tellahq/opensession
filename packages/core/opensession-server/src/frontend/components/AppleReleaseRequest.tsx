import type { AppleReleaseApprovalRequest } from "../lib/api/apple-mobile";

const ACTION_LABELS: Record<AppleReleaseApprovalRequest["action"], string> = {
  adhoc: "Ad-hoc export",
  testflight: "TestFlight upload",
  upload: "IPA upload",
  submit: "Submit for App Review",
  release: "Release on the App Store",
};

export function appleReleaseActionLabel(
  action: AppleReleaseApprovalRequest["action"],
): string {
  return ACTION_LABELS[action] ?? "Apple release";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className="m-0">
        <code className="block break-all text-dim">{value}</code>
      </dd>
    </div>
  );
}

/** Everything an approver checks before approving one Apple release plan.
 *  Every value comes from the server's signed approval request. */
export function AppleReleaseRequestDetails({
  request,
}: {
  request: AppleReleaseApprovalRequest;
}) {
  const version =
    request.marketingVersion || request.buildNumber
      ? `${request.marketingVersion ?? "Version unchanged"}${
          request.buildNumber ? ` (${request.buildNumber})` : ""
        }`
      : null;
  return (
    <div className="min-w-0 flex-1">
      <div className="text-item-title font-medium text-fg">
        {appleReleaseActionLabel(request.action)}
      </div>
      <div className="mt-1 text-meta text-dim [overflow-wrap:anywhere]">
        {[request.bundleId, version].filter(Boolean).join(" · ")}
      </div>
      {request.effects?.length ? (
        <ul className="m-0 mt-2 grid list-disc gap-1 pl-4 text-supporting text-fg">
          {request.effects.map((effect, index) => (
            <li key={index} className="[overflow-wrap:anywhere]">
              {effect}
            </li>
          ))}
        </ul>
      ) : null}
      {request.whatsNew ? (
        <div className="mt-2 text-meta">
          <div className="text-faint">What&rsquo;s new</div>
          <p className="m-0 whitespace-pre-wrap text-dim [overflow-wrap:anywhere]">
            {request.whatsNew}
          </p>
        </div>
      ) : null}
      <dl className="m-0 mt-2 grid gap-1.5 text-meta">
        <Row label="Project" value={request.projectDir} />
        <Row label="Plan ID" value={request.planId} />
        <Row label="Commit" value={`${request.commit} (${request.branch})`} />
        {request.action === "upload" ? (
          <>
            <Row
              label="Artifact"
              value={request.sourceArtifactName ?? "Missing artifact name"}
            />
            <Row
              label="SHA-256"
              value={request.sourceArtifactSha256 ?? "Missing artifact hash"}
            />
          </>
        ) : null}
      </dl>
    </div>
  );
}
