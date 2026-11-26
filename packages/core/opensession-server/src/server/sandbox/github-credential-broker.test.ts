import { describe, expect, test } from "bun:test";
import {
  brokerGithubCredentials,
  brokeredGithubCredential,
  ghShimEnsureScript,
  GITHUB_CREDENTIAL_PATH,
  GITHUB_CREDENTIAL_TOKEN_ENV,
  GITHUB_CREDENTIAL_URL_ENV,
  githubShimDir,
  handleGithubCredentialRequest,
  revokeGithubCredentialsForRun,
  revokeGithubCredentialsForSandbox,
} from "./github-credential-broker";
import { INLINE_GITHUB_CREDENTIAL_HELPER } from "../remote-workspace";
import { INLINE_GITHUB_READ_CREDENTIAL_HELPER } from "../github-git-credential";

const ENDPOINT = `https://os.example.test${GITHUB_CREDENTIAL_PATH}`;
const HOME = "/home/ubuntu";

function runEnv(token = "ghs_primary"): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GH_READ_TOKEN: "ghs_read",
    OPENSESSION_GITHUB_OWNER_TOKEN_acme: "ghs_acme",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com/acme/docs.git.helper",
    GIT_CONFIG_VALUE_1: INLINE_GITHUB_READ_CREDENTIAL_HELPER,
    GIT_CONFIG_KEY_2: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_2: INLINE_GITHUB_CREDENTIAL_HELPER,
    OS_TMPDIR: "/tmp/x",
  };
}

function broker(runToken: string, env = runEnv(), sandboxId = "sbx-1") {
  return brokerGithubCredentials({
    runToken,
    sessionId: "os-1",
    sandboxId,
    env,
    endpoint: ENDPOINT,
    home: HOME,
  });
}

function post(lease: string | undefined, name: string): Request {
  return new Request(`https://os.example.test${GITHUB_CREDENTIAL_PATH}`, {
    method: "POST",
    headers: {
      ...(lease ? { authorization: `Bearer ${lease}` } : {}),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `name=${encodeURIComponent(name)}`,
  });
}

describe("brokerGithubCredentials", () => {
  test("keeps every GitHub token out of the Sandbox command", () => {
    const { env, brokered } = broker("run-a");
    expect(brokered).toBe(true);
    const serialized = JSON.stringify(env);
    for (const secret of ["ghs_primary", "ghs_read", "ghs_acme"])
      expect(serialized).not.toContain(secret);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_READ_TOKEN).toBeUndefined();
    expect(env.OPENSESSION_GITHUB_OWNER_TOKEN_acme).toBeUndefined();
    expect(env[GITHUB_CREDENTIAL_URL_ENV]).toBe(ENDPOINT);
    expect(env[GITHUB_CREDENTIAL_TOKEN_ENV]).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(env.OS_TMPDIR).toBe("/tmp/x");
    revokeGithubCredentialsForRun("run-a");
  });

  test("points each credential helper at the variable it read", () => {
    const { env } = broker("run-b");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env.GIT_CONFIG_VALUE_1).toContain("name=GH_READ_TOKEN");
    expect(env.GIT_CONFIG_VALUE_2).toContain("name=GH_TOKEN");
    for (const index of [1, 2]) {
      expect(env[`GIT_CONFIG_VALUE_${index}`]).toContain(
        `$${GITHUB_CREDENTIAL_URL_ENV}`,
      );
      expect(env[`GIT_CONFIG_VALUE_${index}`]).not.toContain("$GH_TOKEN");
    }
    revokeGithubCredentialsForRun("run-b");
  });

  test("puts the gh shim first on PATH", () => {
    const { env } = broker("run-c");
    expect(env.PATH).toBe(`${githubShimDir(HOME)}:/usr/bin:/bin`);
    revokeGithubCredentialsForRun("run-c");
  });

  test("leaves a command without GitHub credentials untouched", () => {
    const plain = { PATH: "/usr/bin", HOME, GH_TOKEN: "" };
    const result = broker("run-d", plain);
    expect(result.brokered).toBe(false);
    expect(result.env).toBe(plain);
  });

  test("one lease per run, answering with the latest command's tokens", () => {
    const first = broker("run-e", runEnv("ghs_one"));
    const second = broker("run-e", runEnv("ghs_two"));
    const lease = first.env[GITHUB_CREDENTIAL_TOKEN_ENV];
    expect(second.env[GITHUB_CREDENTIAL_TOKEN_ENV]).toBe(lease);
    expect(brokeredGithubCredential(lease, "GH_TOKEN")).toEqual({
      ok: true,
      value: "ghs_two",
    });
    revokeGithubCredentialsForRun("run-e");
  });

  test("a different run gets a different lease", () => {
    const a = broker("run-f1").env[GITHUB_CREDENTIAL_TOKEN_ENV];
    const b = broker("run-f2").env[GITHUB_CREDENTIAL_TOKEN_ENV];
    expect(a).not.toBe(b);
    revokeGithubCredentialsForRun("run-f1");
    revokeGithubCredentialsForRun("run-f2");
  });
});

describe("lease lifetime", () => {
  test("revoking the run kills its lease", () => {
    const lease = broker("run-g").env[GITHUB_CREDENTIAL_TOKEN_ENV];
    revokeGithubCredentialsForRun("run-g");
    expect(brokeredGithubCredential(lease, "GH_TOKEN")).toEqual({
      ok: false,
      status: 401,
    });
  });

  test("retiring the Sandbox kills its runs' leases", () => {
    const lease = broker("run-h", runEnv(), "sbx-gone").env[
      GITHUB_CREDENTIAL_TOKEN_ENV
    ];
    const other = broker("run-i", runEnv(), "sbx-kept").env[
      GITHUB_CREDENTIAL_TOKEN_ENV
    ];
    revokeGithubCredentialsForSandbox("sbx-gone");
    expect(brokeredGithubCredential(lease, "GH_TOKEN").ok).toBe(false);
    expect(brokeredGithubCredential(other, "GH_TOKEN").ok).toBe(true);
    revokeGithubCredentialsForRun("run-i");
  });

  test("a run moved to another Sandbox gets a fresh lease", () => {
    const old = broker("run-j", runEnv(), "sbx-1").env[
      GITHUB_CREDENTIAL_TOKEN_ENV
    ];
    const moved = broker("run-j", runEnv(), "sbx-2").env[
      GITHUB_CREDENTIAL_TOKEN_ENV
    ];
    expect(moved).not.toBe(old);
    expect(brokeredGithubCredential(old, "GH_TOKEN").ok).toBe(false);
    revokeGithubCredentialsForRun("run-j");
  });

  test("an idle lease expires", () => {
    const { env } = brokerGithubCredentials({
      runToken: "run-k",
      sessionId: "os-1",
      sandboxId: "sbx-1",
      env: runEnv(),
      endpoint: ENDPOINT,
      home: HOME,
      now: 1_000,
    });
    const lease = env[GITHUB_CREDENTIAL_TOKEN_ENV];
    expect(brokeredGithubCredential(lease, "GH_TOKEN", 2_000).ok).toBe(true);
    expect(
      brokeredGithubCredential(lease, "GH_TOKEN", 1_000 + 7 * 60 * 60_000),
    ).toEqual({ ok: false, status: 401 });
  });
});

describe("handleGithubCredentialRequest", () => {
  test("answers a live lease with the named token", async () => {
    const lease = broker("run-l").env[GITHUB_CREDENTIAL_TOKEN_ENV];
    const ok = await handleGithubCredentialRequest(post(lease, "GH_TOKEN"));
    expect(ok?.status).toBe(200);
    expect(await ok?.text()).toBe("ghs_primary");
    expect(ok?.headers.get("cache-control")).toBe("no-store");
    const owner = await handleGithubCredentialRequest(
      post(lease, "OPENSESSION_GITHUB_OWNER_TOKEN_acme"),
    );
    expect(await owner?.text()).toBe("ghs_acme");
    revokeGithubCredentialsForRun("run-l");
  });

  test("refuses a missing, unknown, or revoked lease", async () => {
    expect(
      (await handleGithubCredentialRequest(post(undefined, "GH_TOKEN")))
        ?.status,
    ).toBe(401);
    expect(
      (await handleGithubCredentialRequest(post("nope", "GH_TOKEN")))?.status,
    ).toBe(401);
    const lease = broker("run-m").env[GITHUB_CREDENTIAL_TOKEN_ENV];
    revokeGithubCredentialsForRun("run-m");
    expect(
      (await handleGithubCredentialRequest(post(lease, "GH_TOKEN")))?.status,
    ).toBe(401);
  });

  test("hands out only GitHub credential variables", async () => {
    const lease = broker("run-n").env[GITHUB_CREDENTIAL_TOKEN_ENV];
    expect(
      (await handleGithubCredentialRequest(post(lease, "PATH")))?.status,
    ).toBe(400);
    revokeGithubCredentialsForRun("run-n");
  });

  test("404 for a credential the run does not hold", async () => {
    const env = runEnv();
    delete env.GH_READ_TOKEN;
    const lease = broker("run-o", env).env[GITHUB_CREDENTIAL_TOKEN_ENV];
    expect(
      (await handleGithubCredentialRequest(post(lease, "GH_READ_TOKEN")))
        ?.status,
    ).toBe(404);
    revokeGithubCredentialsForRun("run-o");
  });

  test("ignores other paths and refuses other methods", async () => {
    expect(
      await handleGithubCredentialRequest(
        new Request("https://os.example.test/workload-identity/token", {
          method: "POST",
        }),
      ),
    ).toBeUndefined();
    expect(
      (
        await handleGithubCredentialRequest(
          new Request(`https://os.example.test${GITHUB_CREDENTIAL_PATH}`),
        )
      )?.status,
    ).toBe(405);
  });
});

describe("in a shell", () => {
  async function sh(
    script: string,
    env: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bash", "-c", script], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
    proc.stdin.write("protocol=https\nhost=github.com\n\n");
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  test("the git helper and the gh shim fetch the token over HTTP", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) =>
        (await handleGithubCredentialRequest(req)) ??
        new Response(null, { status: 404 }),
    });
    const home = `${process.env.TMPDIR || "/tmp"}/gh-broker-${crypto.randomUUID()}`;
    try {
      const endpoint = `http://127.0.0.1:${server.port}${GITHUB_CREDENTIAL_PATH}`;
      const { env } = brokerGithubCredentials({
        runToken: "run-shell",
        sessionId: "os-1",
        sandboxId: "sbx-1",
        env: { ...runEnv(), PATH: "/usr/bin:/bin", HOME: home },
        endpoint,
        home,
      });
      const helper = env.GIT_CONFIG_VALUE_2.slice(1);
      const got = await sh(`${helper} get`, env);
      expect(got.stdout).toBe(
        "username=x-access-token\npassword=ghs_primary\n",
      );
      expect((await sh(`${helper} store`, env)).stdout).toBe("");

      // The shim writes itself once, then execs the real gh with GH_TOKEN;
      // point it at a stand-in that prints what it was given.
      const ensure = ghShimEnsureScript(home);
      expect((await sh(ensure, env)).code).toBe(0);
      const shim = `${githubShimDir(home)}/gh`;
      const source = await Bun.file(shim).text();
      await Bun.write(
        shim,
        source.replace(
          /exec \/usr\/local\/bin\/gh "\$@"/,
          'printf "%s %s" "$GH_TOKEN" "$*"',
        ),
      );
      const shimmed = await sh("gh auth status", env);
      expect(shimmed.stdout).toBe("ghs_primary auth status");
      const explicit = await sh("GH_TOKEN=mine gh pr list", env);
      expect(explicit.stdout).toBe("mine pr list");

      revokeGithubCredentialsForRun("run-shell");
      expect((await sh(`${helper} get`, env)).stdout).toBe("");
      const refused = await sh("gh api user", env);
      expect(refused.stdout).toBe(" api user");
      expect(refused.stderr).toContain("no GitHub token");
    } finally {
      server.stop(true);
      await Bun.$`rm -rf ${home}`.quiet().nothrow();
    }
  });
});
