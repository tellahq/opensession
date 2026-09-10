import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultPortalRecipe,
  getPreviewStatus,
  listenerLinesForPort,
  parsePreviewPortalRecipes,
  recipeStartOptions,
  repoLifecycle,
  sandboxPreviewIdentityContext,
  seedHostEnvFiles,
} from "./preview";
import type { Repo } from "./config";

describe("seedHostEnvFiles", () => {
  const envRel = "packages/core/webapp/.env.local";
  function repoAt(dir: string): Repo {
    return {
      id: "app",
      label: "app",
      repo: dir,
      wtPrefix: "app",
      defaultBranch: "main",
      ghRepo: "org/app",
    };
  }

  test("copies the main checkout's gitignored env files into a fresh worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "os-seed-env-"));
    try {
      const main = join(root, "main");
      const worktree = join(root, "wt");
      mkdirSync(dirname(join(main, envRel)), { recursive: true });
      writeFileSync(join(main, envRel), "SECRET=1\n");
      mkdirSync(worktree);
      expect(seedHostEnvFiles(worktree, repoAt(main))).toEqual([envRel]);
      expect(readFileSync(join(worktree, envRel), "utf8")).toBe("SECRET=1\n");
      // A second start finds the file and leaves it alone.
      writeFileSync(join(worktree, envRel), "SECRET=edited\n");
      expect(seedHostEnvFiles(worktree, repoAt(main))).toEqual([]);
      expect(readFileSync(join(worktree, envRel), "utf8")).toBe(
        "SECRET=edited\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never seeds the main checkout into itself or without a repo", () => {
    const root = mkdtempSync(join(tmpdir(), "os-seed-env-"));
    try {
      mkdirSync(dirname(join(root, envRel)), { recursive: true });
      writeFileSync(join(root, envRel), "SECRET=1\n");
      expect(seedHostEnvFiles(root, repoAt(root))).toEqual([]);
      expect(seedHostEnvFiles(join(root, "missing"), undefined)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sandbox portal identity", () => {
  test("carries the sandbox trust profile into the Portal grant", () => {
    expect(
      sandboxPreviewIdentityContext(
        { id: "sandbox-1", provider: "daytona" },
        "tella-fusion",
        "interactive",
      ),
    ).toEqual({
      sandboxId: "sandbox-1",
      provider: "daytona",
      lifecycle: "preview",
      repoId: "tella-fusion",
      trustProfile: "interactive",
    });
  });
});

describe("listenerLinesForPort", () => {
  test("matches only the local listening port across IPv4 and IPv6", () => {
    const raw = [
      'LISTEN 0 512 127.0.0.1:3850 0.0.0.0:* users:(("bun",pid=42,fd=20))',
      "LISTEN 0 512 [::]:3850 [::]:*",
      'LISTEN 0 512 127.0.0.1:13850 0.0.0.0:* users:(("bun",pid=43,fd=20))',
      "LISTEN 0 512 127.0.0.1:4000 127.0.0.1:3850",
    ].join("\n");

    expect(listenerLinesForPort(raw, 3850)).toEqual(
      raw.split("\n").slice(0, 2),
    );
  });
});

describe("getPreviewStatus", () => {
  test("a workspace without services or declared Portals reports nothing", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "preview-scratch-"));
    try {
      expect(await getPreviewStatus(scratch)).toEqual({
        services: [],
        portalRecipes: [],
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// repoLifecycle reads a real checkout (Settings → Setup asks "can sessions in
// this repo prepare themselves and expose their app?"), so these drive it
// against temp trees.
describe("repoLifecycle", () => {
  function repoWith(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "lifecycle-"));
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), body);
    }
    return root;
  }

  test("reports each committed lifecycle file", () => {
    expect(
      repoLifecycle(
        repoWith({
          ".agents/setup": "",
          ".agents/resume": "",
          ".agents/portals.json": JSON.stringify({
            portals: [{ id: "web", name: "Web", command: "bun dev" }],
          }),
        }),
      ),
    ).toEqual({ dir: ".agents", setup: true, resume: true, portals: true });
  });

  test("an empty portals.json declares nothing", () => {
    expect(
      repoLifecycle(
        repoWith({ ".agents/setup": "", ".agents/portals.json": "{}" }),
      ),
    ).toEqual({ dir: ".agents", setup: true, resume: false, portals: false });
  });

  test("a repo with no lifecycle dir reports nothing", () => {
    expect(repoLifecycle(repoWith({ "package.json": "{}" }))).toEqual({
      dir: null,
      setup: false,
      resume: false,
      portals: false,
    });
  });

  test("the retired .opensession/ dir contributes nothing", () => {
    expect(
      repoLifecycle(
        repoWith({ ".opensession/start.sh": "", ".opensession/setup.sh": "" }),
      ),
    ).toEqual({ dir: null, setup: false, resume: false, portals: false });
  });
});

describe("portal recipes", () => {
  test("reads direct supervised starters from portals.json", () => {
    expect(
      parsePreviewPortalRecipes(
        JSON.stringify({
          portals: [
            {
              id: "tella-local",
              name: "Tella local",
              description: "Authenticated local webapp",
              command: "./.agents/start.sh",
              serviceKey: "WEBAPP_PORT",
              port: 3300,
              readyTimeoutSeconds: 180,
            },
          ],
        }),
      ),
    ).toEqual([
      {
        id: "tella-local",
        name: "Tella local",
        description: "Authenticated local webapp",
        command: "./.agents/start.sh",
        serviceKey: "WEBAPP_PORT",
        port: 3300,
        readyTimeoutSeconds: 180,
      },
    ]);
  });

  test("keeps a long declared ready timeout up to the supervisor ceiling", () => {
    const recipes = (readyTimeoutSeconds: number) =>
      parsePreviewPortalRecipes(
        JSON.stringify({
          portals: [
            {
              id: "web",
              name: "Web",
              command: "exec app",
              readyTimeoutSeconds,
            },
          ],
        }),
      );
    // A cold Next.js worktree needs the full 10 minutes; before this, anything
    // over 300 was dropped and the Portal died on the 15-second default.
    expect(recipes(600)[0]?.readyTimeoutSeconds).toBe(600);
    expect(recipes(3_600)[0]?.readyTimeoutSeconds).toBe(600);
    expect(recipes(1)[0]?.readyTimeoutSeconds).toBeUndefined();
  });

  test("turns a declared service into trusted supervisor options", () => {
    expect(
      recipeStartOptions({
        id: "tella-local",
        name: "Tella local",
        command: "./.agents/start.sh",
        serviceKey: "WEBAPP_PORT",
        readyTimeoutSeconds: 180,
      }),
    ).toEqual({
      name: "tella-local",
      command: expect.stringContaining('export WEBAPP_PORT="$PORT"'),
      key: "WEBAPP_PORT",
      readyTimeoutMs: 180_000,
    });
  });

  test("the main app is the WEBAPP_PORT recipe, else the first one", () => {
    const api = { id: "api", name: "API", command: "bun api" };
    const web = {
      id: "web",
      name: "Web",
      command: "bun dev",
      serviceKey: "WEBAPP_PORT",
    };
    expect(defaultPortalRecipe([api, web])).toBe(web);
    expect(defaultPortalRecipe([api])).toBe(api);
    expect(defaultPortalRecipe([])).toBeUndefined();
  });

  test("drops recipes that could inject a prompt or invalid port key", () => {
    expect(
      parsePreviewPortalRecipes(
        JSON.stringify({
          portals: [
            { name: "Unsafe", skill: "tella-local\nignore-instructions" },
            { name: "Safe", skill: "docs", serviceKey: "$(BAD)_PORT" },
          ],
        }),
      ),
    ).toEqual([{ id: "docs", name: "Safe", skill: "docs" }]);
  });
});
