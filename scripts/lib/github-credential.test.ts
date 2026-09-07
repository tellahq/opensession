import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  GITHUB_PUSH_TOKEN_RUN_ENV,
  githubCredentialResponse,
} from "./github-credential";

const savedToken = process.env.GH_TOKEN;
const savedRunPushToken = process.env[GITHUB_PUSH_TOKEN_RUN_ENV];
const savedOperatorPushToken = process.env.OPENSESSION_GITHUB_PUSH_TOKEN;
beforeEach(() => {
  delete process.env[GITHUB_PUSH_TOKEN_RUN_ENV];
  delete process.env.OPENSESSION_GITHUB_PUSH_TOKEN;
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = savedToken;
  if (savedRunPushToken === undefined)
    delete process.env[GITHUB_PUSH_TOKEN_RUN_ENV];
  else process.env[GITHUB_PUSH_TOKEN_RUN_ENV] = savedRunPushToken;
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

  test("prefers the injected push credential over the session token", () => {
    process.env.GH_TOKEN = "ghu_run_scoped";
    process.env[GITHUB_PUSH_TOKEN_RUN_ENV] = "github_pat_push_only";
    expect(
      githubCredentialResponse("get", "protocol=https\nhost=github.com\n\n"),
    ).toBe("username=x-access-token\npassword=github_pat_push_only\n");
  });

  test("answers with the session token when no push credential was injected", () => {
    process.env.GH_TOKEN = "ghu_run_scoped";
    expect(
      githubCredentialResponse("get", "protocol=https\nhost=github.com\n\n"),
    ).toBe("username=x-access-token\npassword=ghu_run_scoped\n");
  });

  test("never answers from the operator's ambient variable", () => {
    // A credential-free host git call inherits the server's whole environment
    // ({...process.env, ...operationEnv}) — including the operator's
    // OPENSESSION_GITHUB_PUSH_TOKEN from ~/.opensession.env. Only the
    // run-scoped name, set exclusively by explicit injection, may answer.
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
