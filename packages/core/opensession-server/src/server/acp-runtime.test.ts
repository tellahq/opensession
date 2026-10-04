import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfig, configPath, publishConfigSnapshot } from "./config";
import { resolveAcpMcp, acpModelMetadata } from "./acp-runtime";

test("ACP grants only scoped stdio connectors and refuses unimplementable confirmations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-mcp-"));
  const previous = getConfig();
  try {
    const path = join(dir, "mcp.json");
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          cli: {
            command: "example-cli",
            args: ["--mcp"],
            env: { PROFILE: "example" },
          },
          denied: { command: "denied-cli", allowedUsers: ["somebody-else"] },
          web: { url: "https://example.test/mcp" },
        },
      }),
    );
    publishConfigSnapshot(
      configPath(),
      JSON.stringify({
        ...previous,
        paths: { ...previous.paths, mcpConfig: path },
        acp: [
          {
            id: "missing",
            name: "Missing",
            command: "/nonexistent/example-agent",
          },
        ],
      }),
    );
    const opts = {
      prompt: "Hi",
      cwd: dir,
      user: "Example",
      mcpServers: "all" as const,
    };
    const servers = await resolveAcpMcp(opts, "scoped-token");
    expect(servers.map((server) => server.name)).toEqual(["cli"]);
    expect(servers[0].env).toEqual([{ name: "PROFILE", value: "example" }]);
    expect(
      await resolveAcpMcp({ ...opts, mcpServers: [] }, "scoped-token"),
    ).toEqual([]);
    await expect(
      resolveAcpMcp(
        { ...opts, confirmTools: { write: "Confirm" } },
        "scoped-token",
      ),
    ).rejects.toThrow("confirmation-required");
    const models = await acpModelMetadata();
    expect(models[0]).toMatchObject({
      id: "acp/missing",
      available: false,
      engineCapabilities: { supportsSteering: false },
    });
    expect(models[0].unavailableReason).toContain("unavailable");
  } finally {
    publishConfigSnapshot(configPath(), JSON.stringify(previous));
    await rm(dir, { recursive: true, force: true });
  }
});
