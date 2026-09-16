/** Personal Apps have no organization membership or webhook authority. */
export const PERSONAL_APP_PERMISSIONS: Readonly<Record<string, string>> =
  Object.freeze({
    contents: "write",
    pull_requests: "write",
    issues: "write",
    actions: "read",
    checks: "read",
    statuses: "read",
    deployments: "read",
    metadata: "read",
  });
