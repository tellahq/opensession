import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { githubCredentialResponse } from "./github-credential";

const savedToken = process.env.GH_TOKEN;
const savedOperatorPushToken = process.env.OPENSESSION_GITHUB_PUSH_TOKEN;
beforeEach(() => {
  delete process.env.OPENSESSION_GITHUB_PUSH_TOKEN;
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = savedToken;
  if (savedOperatorPushToken === undefined)
    delete process.env.OPENSESSION_GITHUB_PUSH_TOKEN;
  else process.env.OPENSESSION_GITHUB_PUSH_TOKEN = savedOperatorPushToken;
});

describe("GitHub credential helper", () => {
  test("prefers the run-scoped token used by org-mode sessions", () => {
    process.env.GH_TOKEN = "ghu_run_scoped";
    expect(
      githubCredentialResponse("get", "protocol=https\nhost=github.com\n\n"),
    ).toBe("username=x-access-token\npassword=ghu_run_scoped\n");
  });

  test("does not resolve a recorded login without a run-scoped token", () => {
    delete process.env.GH_TOKEN;
    expect(
      githubCredentialResponse(
        "get",
        "protocol=https\nhost=github.com\nusername=alice\n\n",
      ),
    ).toBe("");
  });

  test("answers with the run's own token", () => {
    process.env.GH_TOKEN = "ghu_run_scoped";
    expect(
      githubCredentialResponse("get", "protocol=https\nhost=github.com\n\n"),
    ).toBe("username=x-access-token\npassword=ghu_run_scoped\n");
  });

  test("never answers from the operator's ambient variable", () => {
    // A credential-free host git call inherits the server's whole environment
    // ({...process.env, ...operationEnv}). A retired operator variable that
    // used to name a git-only credential must never answer.
    delete process.env.GH_TOKEN;
    process.env.OPENSESSION_GITHUB_PUSH_TOKEN = "github_pat_push_only";
    expect(
      githubCredentialResponse("get", "protocol=https\nhost=github.com\n\n"),
    ).toBe("");
    process.env.GH_TOKEN = "ghu_run_scoped";
    expect(
      githubCredentialResponse("get", "protocol=https\nhost=github.com\n\n"),
    ).toBe("username=x-access-token\npassword=ghu_run_scoped\n");
  });

  test("answers nothing for a credential-free run with both unset", () => {
    delete process.env.GH_TOKEN;
    expect(
      githubCredentialResponse("get", "protocol=https\nhost=github.com\n\n"),
    ).toBe("");
  });

  test("ignores writes and non-GitHub hosts", () => {
    process.env.GH_TOKEN = "ghu_run_scoped";
    expect(
      githubCredentialResponse("store", "protocol=https\nhost=github.com\n\n"),
    ).toBe("");
    expect(
      githubCredentialResponse("get", "protocol=https\nhost=example.com\n\n"),
    ).toBe("");
  });
});
