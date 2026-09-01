import { afterEach, describe, expect, test } from "bun:test";
import { githubCredentialResponse } from "./github-credential";

const savedToken = process.env.GH_TOKEN;
afterEach(() => {
  if (savedToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = savedToken;
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
