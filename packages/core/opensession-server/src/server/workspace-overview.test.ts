import { describe, expect, it, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { isWorkspaceArtifact } from "./workspace-overview";

const dir = mkdtempSync(join(tmpdir(), "ws-overview-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const none = new Set<string>();
const mediaSrc = (path: string) => `/media?path=${encodeURIComponent(path)}`;

describe("isWorkspaceArtifact (what the overview filmstrip shows)", () => {
  it("keeps bytes the server holds", () => {
    expect(isWorkspaceArtifact("data:image/png;base64,AAAA", none)).toBe(true);
    expect(isWorkspaceArtifact("os-blob:abc/0", none)).toBe(true);
    expect(
      isWorkspaceArtifact("/api/sessions/s1/transcript-image/e1/0", none),
    ).toBe(true);
  });

  it("keeps a local file that still exists, drops one that doesn't", () => {
    const path = join(dir, "shot.png");
    writeFileSync(path, "x");
    expect(isWorkspaceArtifact(mediaSrc(path), none)).toBe(true);
    // Scratch under /tmp gets swept; the tile would be a broken image.
    expect(isWorkspaceArtifact(mediaSrc(join(dir, "gone.png")), none)).toBe(
      false,
    );
    // Pre-rename srcs are still stored with the old path prefix; they redirect.
    expect(
      isWorkspaceArtifact(
        `/backstage/media?path=${encodeURIComponent(path)}`,
        none,
      ),
    ).toBe(true);
  });

  it("drops a remote URL a tool merely mentioned", () => {
    expect(isWorkspaceArtifact("https://example.com/image.png", none)).toBe(
      false,
    );
    expect(
      isWorkspaceArtifact("https://avatars.slack-edge.com/a.png", none),
    ).toBe(false);
    expect(
      isWorkspaceArtifact("https://cdn.tella.tv/renders/demo.mp4", none),
    ).toBe(false);
  });

  it("keeps a remote URL the agent explicitly featured", () => {
    const src = "https://cdn.tella.tv/renders/demo.mp4";
    expect(isWorkspaceArtifact(src, new Set([src]))).toBe(true);
  });
});
