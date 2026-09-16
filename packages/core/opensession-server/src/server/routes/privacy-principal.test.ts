import { expect, test } from "bun:test";
import {
  EXPECTED_GITHUB_ACCOUNT_HEADER,
  PERSONAL_PRIVACY_HEADER,
} from "../../shared/access-scope";
import type { RouteContext } from "./context";
import { privacyPrincipalAdmission } from "./privacy-principal";

function context(
  path: string,
  headers: Record<string, string> = {},
  owner: number | undefined = 41,
): RouteContext {
  const url = new URL(path, "https://fixture.invalid");
  return {
    req: new Request(url, { headers }),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser: { login: "alice", name: "Same name", githubAccountId: owner },
  };
}
const modern = {
  [PERSONAL_PRIVACY_HEADER]: "personal-v1",
  [EXPECTED_GITHUB_ACCOUNT_HEADER]: "41",
};

test("HTTP admission binds captured numeric identity before shared effects", async () => {
  const ctx = context("/api/sessions/shared/prompt", modern, 42);
  let effects = 0;
  const rejection = privacyPrincipalAdmission(ctx);
  if (!rejection) effects++;
  expect(effects).toBe(0);
  expect(rejection?.status).toBe(409);
  expect(rejection?.headers.get("cache-control")).toBe("no-store");
  expect(await rejection?.json()).toMatchObject({ code: "principal_changed" });
  expect(ctx.applicationAccess).toBeUndefined();
  const matching = context("/api/sessions", modern);
  expect(privacyPrincipalAdmission(matching)).toBeUndefined();
  expect(matching.applicationAccess?.principal?.githubAccountId).toBe(41);
});

test("old and unknown clients remain shared-only despite verified identity", () => {
  for (const value of [undefined, "future-v2", "personal-v1, personal-v1"]) {
    const ctx = context(
      "/api/repos",
      value ? { [PERSONAL_PRIVACY_HEADER]: value } : {},
    );
    expect(privacyPrincipalAdmission(ctx)).toBeUndefined();
    expect(ctx.applicationAccess?.audience).toBe("shared");
    expect(ctx.applicationAccess?.principal).toBeUndefined();
  }
});

test("modern requests reject malformed expected ids and nonhuman authority", () => {
  for (const value of [
    "",
    "041",
    "41.0",
    "4.1e1",
    "-41",
    "41, 41",
    "9007199254740992",
  ]) {
    expect(
      privacyPrincipalAdmission(
        context("/api/repos", {
          ...modern,
          [EXPECTED_GITHUB_ACCOUNT_HEADER]: value,
        }),
      )?.status,
    ).toBe(409);
  }
  const legacy = context("/api/repos", modern);
  delete legacy.authUser!.githubAccountId;
  expect(privacyPrincipalAdmission(legacy)?.status).toBe(409);
  const machine = context("/api/repos", modern);
  machine.authUser!.automation = true;
  expect(privacyPrincipalAdmission(machine)?.status).toBe(409);
});

test("auth discovery can learn the new identity instead of looping on mismatch", () => {
  const ctx = context("/api/auth/status", modern, 42);
  expect(privacyPrincipalAdmission(ctx)).toBeUndefined();
  expect(ctx.applicationAccess).toBeUndefined();
  expect(
    privacyPrincipalAdmission(context("/api/auth/logout", modern, 42))?.status,
  ).toBe(409);
});

test("WS privacy is declared only by exact single upgrade query fields", () => {
  const matching = context("/ws?privacy=personal-v1&githubAccountId=41");
  expect(privacyPrincipalAdmission(matching)).toBeUndefined();
  expect(matching.applicationAccess?.principal?.githubAccountId).toBe(41);
  for (const path of [
    "/ws?privacy=personal-v1",
    "/ws?privacy=personal-v1&githubAccountId=42",
    "/ws?privacy=personal-v1&githubAccountId=41&githubAccountId=41",
    "/ws?privacy=personal-v1&githubAccountId=041",
  ])
    expect(privacyPrincipalAdmission(context(path))?.status).toBe(409);
  for (const path of [
    "/ws",
    "/ws?privacy=future-v2&githubAccountId=41",
    "/ws?privacy=personal-v1&privacy=personal-v1&githubAccountId=41",
  ]) {
    const ctx = context(path, modern);
    expect(privacyPrincipalAdmission(ctx)).toBeUndefined();
    expect(ctx.applicationAccess?.principal).toBeUndefined();
  }
});
