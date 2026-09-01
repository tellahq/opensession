import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getPreviewStatus,
  listenerLinesForPort,
  parsePreviewPortalRecipes,
  recipeStartOptions,
  repoLifecycle,
  resolvePreviewBoot,
  sandboxPreviewIdentityContext,
  seedSandboxPortsConf,
  startPreview,
} from "./preview";

// The resolver is the ONE bring-up chain shared by host and sandbox previews:
// repo-committed .agents/start.sh → configured previewCommand.
// `exists` abstracts host-fs vs in-container checks, so these tests drive it
// with plain sets of paths.

const WT = "/srv/worktrees/widget-some-branch";
const PREVIEW_COMMAND = "/srv/opensession/bin/start-widget-preview";

function existsIn(paths: string[]) {
  return (p: string) => paths.includes(p);
}

describe("sandbox preview identity", () => {
  test("carries the sandbox trust profile into the preview grant", () => {
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

  test("adds WEBAPP_PORT when Portal records created the registry first", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "sandbox-preview-ports-"));
    const conf = join(scratch, ".ports.conf");
    writeFileSync(
      conf,
      "# opensession-portal {}\nPORTAL_RELAY_SMOKE_PORT=4000\n",
    );
    const sandbox = {
      async exec(command: string[]) {
        const proc = Bun.spawn(command, {
          cwd: scratch,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, exitCode };
      },
    } as any;
    try {
      await seedSandboxPortsConf(sandbox, scratch, 3300);
      expect(await Bun.file(conf).text()).toContain("WEBAPP_PORT=3300");
      expect(await Bun.file(conf).text()).toContain(
        "PORTAL_RELAY_SMOKE_PORT=4000",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("resolvePreviewBoot", () => {
  test("repo-committed .agents/start.sh wins over previewCommand", async () => {
    const boot = await resolvePreviewBoot(
      WT,
      { id: "widget", previewCommand: PREVIEW_COMMAND },
      existsIn([`${WT}/.agents/start.sh`, PREVIEW_COMMAND]),
    );
    expect(boot).toEqual({
      kind: "repo-script",
      cmd: `bash ${WT}/.agents/start.sh`,
      setupScript: undefined,
    });
  });

  test("start.sh resolution picks up the sibling .agents/setup one-shot hook", async () => {
    const boot = await resolvePreviewBoot(
      WT,
      { id: "widget" },
      existsIn([`${WT}/.agents/start.sh`, `${WT}/.agents/setup`]),
    );
    expect(boot?.kind).toBe("repo-script");
    expect(boot?.setupScript).toBe(`${WT}/.agents/setup`);
  });

  test("previewCommand runs with the worktree as $1", async () => {
    const boot = await resolvePreviewBoot(
      WT,
      { id: "widget", previewCommand: PREVIEW_COMMAND },
      existsIn([PREVIEW_COMMAND]),
    );
    expect(boot).toEqual({
      kind: "preview-command",
      cmd: `${PREVIEW_COMMAND} ${WT}`,
    });
  });

  test("non-absolute previewCommand is trusted without an existence check", async () => {
    const boot = await resolvePreviewBoot(
      "/srv/worktrees/docs-some-branch",
      { id: "docs", previewCommand: "npm run dev --" },
      existsIn([]),
    );
    expect(boot).toEqual({
      kind: "preview-command",
      cmd: "npm run dev -- /srv/worktrees/docs-some-branch",
    });
  });

  test("missing absolute previewCommand leaves the repo unbootable", async () => {
    const boot = await resolvePreviewBoot(
      WT,
      { id: "widget", previewCommand: "/nonexistent/bring-up.sh" },
      existsIn([PREVIEW_COMMAND]),
    );
    expect(boot).toBeNull();
  });

  test("a retired .opensession/ dir no longer resolves", async () => {
    const boot = await resolvePreviewBoot(
      WT,
      { id: "widget" },
      existsIn([`${WT}/.opensession/start.sh`, `${WT}/.opensession/setup.sh`]),
    );
    expect(boot).toBeNull();
  });

  test("no mechanism at all resolves to null (UI: disabled Start)", async () => {
    const boot = await resolvePreviewBoot(WT, { id: "widget" }, existsIn([]));
    expect(boot).toBeNull();
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
  test("a repo-less scratch workspace is not bootable", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "preview-scratch-"));
    try {
      expect(await getPreviewStatus(scratch)).toMatchObject({
        hasPortsConf: false,
        running: false,
        starting: false,
        previewUrl: null,
        bootable: false,
        services: [],
      });
      expect(await startPreview(scratch)).toMatchObject({
        running: false,
        starting: false,
        bootable: false,
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// repoLifecycle reads a real checkout (Settings → Setup asks "can sessions in
// this repo boot themselves?"), so these drive it against temp trees.
describe("repoLifecycle", () => {
  function repoWith(files: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "lifecycle-"));
    for (const f of files) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), "");
    }
    return root;
  }

  test("reports each committed lifecycle file", () => {
    expect(
      repoLifecycle(
        repoWith([".agents/setup", ".agents/start.sh", ".agents/preview.json"]),
      ),
    ).toEqual({
      dir: ".agents",
      setup: true,
      start: true,
      previewJson: true,
    });
  });

  test("a repo with no lifecycle dir reports nothing", () => {
    expect(repoLifecycle(repoWith(["package.json"]))).toEqual({
      dir: null,
      setup: false,
      start: false,
      previewJson: false,
    });
  });

  test("the retired .opensession/ dir contributes nothing", () => {
    expect(
      repoLifecycle(
        repoWith([".opensession/start.sh", ".opensession/setup.sh"]),
      ),
    ).toEqual({
      dir: null,
      setup: false,
      start: false,
      previewJson: false,
    });
  });
});

describe("preview portal recipes", () => {
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
