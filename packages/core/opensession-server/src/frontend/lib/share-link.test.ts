import { describe, expect, test } from "bun:test";
import {
  composerSessionRef,
  sessionPath,
  splitSessionRef,
  subagentSuffix,
  workspacePanePath,
} from "./share-link";

// BASE_PATH is "" in this app (URLs serve at the domain root), so the paths
// below are what a copied link actually carries.

describe("sessionPath", () => {
  test("scopes a session to its workspace", () => {
    expect(sessionPath({ id: "os-1", workspaceId: "ws-1" })).toBe(
      "/workspace/ws-1/session/os-1",
    );
  });

  test("keeps the bare form for a workspace-less session", () => {
    expect(sessionPath({ id: "os-1" })).toBe("/session/os-1");
  });

  test("trails the sub-agent the reader is in", () => {
    expect(sessionPath({ id: "os-1", workspaceId: "ws-1" }, ["ses_a"])).toBe(
      "/workspace/ws-1/session/os-1/subagent/ses_a",
    );
  });

  test("carries a nested drill-in as one segment per level", () => {
    expect(sessionPath({ id: "os-1" }, ["ses_a", "ses_b"])).toBe(
      "/session/os-1/subagent/ses_a/ses_b",
    );
  });

  test("encodes every segment", () => {
    expect(sessionPath({ id: "os/1", workspaceId: "ws 1" }, ["a/b"])).toBe(
      "/workspace/ws%201/session/os%2F1/subagent/a%2Fb",
    );
  });
});

describe("splitSessionRef", () => {
  test("reads back a plain session id", () => {
    expect(splitSessionRef("os-1")).toEqual({ id: "os-1", subagent: [] });
  });

  test("reads back a sub-agent breadcrumb", () => {
    expect(splitSessionRef("os-1/subagent/ses_a/ses_b")).toEqual({
      id: "os-1",
      subagent: ["ses_a", "ses_b"],
    });
  });

  test("round-trips what sessionPath wrote, encoding and all", () => {
    const path = sessionPath({ id: "os/1" }, ["a/b"]);
    expect(splitSessionRef(path.replace("/session/", ""))).toEqual({
      id: "os/1",
      subagent: ["a/b"],
    });
  });

  test("leaves a slashed id alone when nothing was drilled into", () => {
    // No `/subagent/` marker, so the whole remainder is still the id — old
    // links keep resolving exactly as they did.
    expect(splitSessionRef("os-1/extra")).toEqual({
      id: "os-1/extra",
      subagent: [],
    });
  });

  test("ignores a trailing slash", () => {
    expect(splitSessionRef("os-1/subagent/ses_a/")).toEqual({
      id: "os-1",
      subagent: ["ses_a"],
    });
  });
});

describe("subagentSuffix", () => {
  test("is empty with nothing open", () => {
    expect(subagentSuffix()).toBe("");
    expect(subagentSuffix([])).toBe("");
  });
});

describe("workspacePanePath", () => {
  test("keeps the selected workspace pane in copied links", () => {
    expect(workspacePanePath("ws 1", "review")).toBe(
      "/workspace/ws%201/review",
    );
    expect(workspacePanePath("ws 1", "conversation")).toBe(
      "/workspace/ws%201/conversation",
    );
  });
});

describe("composerSessionRef", () => {
  const MINTED = "os-01a01ae5-ce77-7000-8874-98ded6c9208f";

  test("writes a minted session as the bare id the composer chips", () => {
    expect(composerSessionRef({ id: MINTED, workspaceId: "ws-1" })).toBe(
      MINTED,
    );
  });

  test("keeps the whole URL for an id that has no bare form", () => {
    // @ts-expect-error — jsdom-less test env; absoluteLink only reads origin.
    globalThis.location = { origin: "https://os.tella.dev" };
    expect(composerSessionRef({ id: "bks-ghpr-5099-review" })).toBe(
      "https://os.tella.dev/session/bks-ghpr-5099-review",
    );
  });
});
