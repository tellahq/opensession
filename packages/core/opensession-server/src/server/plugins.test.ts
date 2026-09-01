import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  forgetInstalledPackage,
  listInstalledPackages,
  packagesCheckoutDir,
  packagesStorePath,
  parseManifest,
  readInstalledPackage,
  recordInstalledPackage,
  skillName,
  skillPathError,
  validateManifest,
  type InstalledPackage,
} from "./plugins";

const VALID = {
  name: "video-library",
  version: "1.0.0",
  description: "Your team's videos as a project.",
  mcpServers: {
    "video-library": {
      type: "http",
      url: "https://mcp.video-library.example/mcp",
      headers: { Authorization: "${VIDEO_LIBRARY_TOKEN}" },
    },
  },
  feeds: [
    {
      id: "video-library",
      title: "Video library",
      refKind: "video-library",
      mcpServers: ["video-library"],
      items: {
        server: "video-library",
        tool: "list_videos",
        map: { id: "id", title: "name" },
      },
    },
  ],
  automations: [
    {
      id: "weekly",
      label: "Weekly digest",
      automation: {
        name: "Video library weekly digest",
        prompt: "Summarise last week.",
        schedule: "0 9 * * 1",
      },
    },
  ],
  skills: ["skills/video-library-editing"],
};

/** A manifest with one field changed, so each case says only what it tests. */
function withServer(server: Record<string, unknown>) {
  return { ...VALID, mcpServers: { "video-library": server } };
}

function errorsOf(input: unknown): string[] {
  const result = validateManifest(input);
  return "errors" in result ? result.errors : [];
}

describe("validateManifest", () => {
  test("a complete manifest validates", () => {
    const result = validateManifest(VALID);
    expect("manifest" in result).toBe(true);
  });

  test("name, version and description are required and shaped", () => {
    expect(errorsOf({ ...VALID, name: "Video library Videos" })).toContainEqual(
      expect.stringContaining("name must be a short slug"),
    );
    expect(errorsOf({ ...VALID, version: "v1" })).toContainEqual(
      expect.stringContaining("version"),
    );
    expect(errorsOf({ ...VALID, description: "  " })).toContainEqual(
      expect.stringContaining("description"),
    );
  });

  test("a package with no artifacts is not a package", () => {
    expect(
      errorsOf({ name: "empty", version: "1.0.0", description: "nothing" }),
    ).toContainEqual(expect.stringContaining("at least one artifact"));
  });

  // The property the format's publishability rests on: there is nowhere in a
  // manifest to put a credential.
  test("credential blocks take references, never values", () => {
    expect(
      errorsOf(
        withServer({
          type: "http",
          url: "https://x.example/mcp",
          headers: { Authorization: "Bearer sk-live-123" },
        }),
      ),
    ).toContainEqual(expect.stringContaining("must be a ${NAME} reference"));
    expect(
      errorsOf(
        withServer({
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "sk-live-123" },
        }),
      ),
    ).toContainEqual(expect.stringContaining("must be a ${NAME} reference"));
    // A reference with anything around it is a value with a reference in it.
    expect(
      errorsOf(
        withServer({ command: "node", env: { TOKEN: "Bearer ${TOKEN}" } }),
      ),
    ).toContainEqual(expect.stringContaining("must be a ${NAME} reference"));
    expect(
      errorsOf(withServer({ command: "node", env: { TOKEN: "${TOKEN}" } })),
    ).toEqual([]);
  });

  test("a token hiding in the URL is refused too", () => {
    expect(
      errorsOf(
        withServer({
          type: "http",
          url: "https://mcp.example/mcp?token=abc123",
        }),
      ),
    ).toContainEqual(expect.stringContaining("no query string"));
    expect(
      errorsOf(
        withServer({ type: "http", url: "https://user:pw@mcp.example/mcp" }),
      ),
    ).toContainEqual(expect.stringContaining("no userinfo"));
  });

  test("a server needs a url or a command, and http means http", () => {
    expect(errorsOf(withServer({ type: "http" }))).toContainEqual(
      expect.stringContaining("needs a url"),
    );
    expect(
      errorsOf(withServer({ type: "http", url: "ftp://mcp.example/mcp" })),
    ).toContainEqual(expect.stringContaining("http(s)"));
  });

  // Who may reach a server is the installing operator's call, not the
  // package's, so a manifest cannot express it at all.
  test("allowedUsers is refused", () => {
    expect(
      errorsOf(
        withServer({
          type: "http",
          url: "https://x.example/mcp",
          allowedUsers: ["michiel"],
        }),
      ),
    ).toContainEqual(expect.stringContaining("allowedUsers"));
  });

  test("a package cannot enable or self-edit its own automation", () => {
    const enabled = {
      ...VALID,
      automations: [
        { id: "weekly", automation: { name: "n", prompt: "p", enabled: true } },
      ],
    };
    expect(errorsOf(enabled)).toContainEqual(
      expect.stringContaining("cannot enable"),
    );
    const selfImprove = {
      ...VALID,
      automations: [
        {
          id: "weekly",
          automation: { name: "n", prompt: "p", selfImprove: true },
        },
      ],
    };
    expect(errorsOf(selfImprove)).toContainEqual(
      expect.stringContaining("self-editing"),
    );
  });

  test("an automation needs a name and a prompt", () => {
    const bare = {
      ...VALID,
      automations: [{ id: "weekly", automation: { name: "n" } }],
    };
    expect(errorsOf(bare)).toContainEqual(
      expect.stringContaining("prompt is required"),
    );
  });

  test("a feed needs an id, a title and a source tool", () => {
    const feeds = [
      {
        id: "video-library",
        title: "Video library",
        items: { server: "video-library" },
      },
    ];
    const errors = errorsOf({ ...VALID, feeds });
    expect(errors).toContainEqual(
      expect.stringContaining("items.tool is required"),
    );
    expect(errors).toContainEqual(
      expect.stringContaining("items.map needs id and title"),
    );
  });

  test("skill paths stay inside the package", () => {
    expect(skillPathError("skills/a")).toBeUndefined();
    expect(skillPathError("../../../etc")).toContain("..");
    expect(skillPathError("/etc/skills")).toContain("relative");
    expect(skillPathError("skills\\a")).toContain("forward slashes");
    expect(errorsOf({ ...VALID, skills: ["../outside"] })).toContainEqual(
      expect.stringContaining("skills[0]"),
    );
  });

  test("skillName is the last segment", () => {
    expect(skillName("skills/video-library-editing")).toBe(
      "video-library-editing",
    );
    expect(skillName("skills/video-library-editing/")).toBe(
      "video-library-editing",
    );
  });

  test("a syntax error reads like one", () => {
    const result = parseManifest("{ not json");
    expect("errors" in result && result.errors[0]).toContain("not valid JSON");
  });
});

describe("the ledger", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "os-packages-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const entry = (over: Partial<InstalledPackage> = {}): InstalledPackage => ({
    name: "video-library",
    version: "1.0.0",
    description: "Video library",
    source: "acme/opensession-video-library",
    dir: `${root}/.opensession-plugins/video-library`,
    installedAt: "2026-08-16T00:00:00.000Z",
    artifacts: [
      { kind: "mcp", ref: "video-library" },
      { kind: "skill", ref: "video-library-editing", hash: "abc" },
    ],
    ...over,
  });

  test("paths resolve under the given root, never the live state dir", () => {
    expect(packagesStorePath(root)).toBe(`${root}/.opensession-plugins.json`);
    expect(packagesCheckoutDir(root)).toBe(`${root}/.opensession-plugins`);
  });

  test("an absent ledger reads as empty rather than throwing", () => {
    expect(listInstalledPackages(root)).toEqual([]);
    expect(readInstalledPackage("video-library", root)).toBeUndefined();
  });

  test("recording twice replaces rather than duplicates", () => {
    recordInstalledPackage(entry(), root);
    recordInstalledPackage(
      entry({ version: "1.1.0", updatedAt: "2026-08-17T00:00:00.000Z" }),
      root,
    );
    const all = listInstalledPackages(root);
    expect(all).toHaveLength(1);
    expect(all[0]!.version).toBe("1.1.0");
    expect(all[0]!.installedAt).toBe("2026-08-16T00:00:00.000Z");
  });

  test("forget is idempotent and leaves other packages alone", () => {
    recordInstalledPackage(entry(), root);
    recordInstalledPackage(entry({ name: "other" }), root);
    expect(forgetInstalledPackage("video-library", root)).toBe(true);
    expect(forgetInstalledPackage("video-library", root)).toBe(false);
    expect(listInstalledPackages(root).map((p) => p.name)).toEqual(["other"]);
  });
});
