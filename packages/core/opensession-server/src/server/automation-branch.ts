function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "automation"
  );
}

/** The session id keeps same-minute event runs distinct and makes intent retries stable. */
export function automationBranchName(input: {
  automationName: string;
  startedAt: Date;
  sessionId: string;
}): string {
  const sessionSuffix = input.sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!sessionSuffix) throw new Error("Automation run needs a session id");
  const timestamp = input.startedAt
    .toISOString()
    .slice(0, 16)
    .replace(/[-T:]/g, "");
  return `auto-${slugify(input.automationName)}-${timestamp}-${sessionSuffix}`;
}
