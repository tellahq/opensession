import { afterEach, expect, test } from "bun:test";
import type { FileMention } from "./api/sessions";
import { publishClientDataIdentity } from "./client-data-scope";
import {
  fetchMentionPalette,
  mentionPaletteScope,
  withoutConnectedServices,
} from "./private-mention-palette";

const rows: FileMention[] = [
  { display: "linear", insert: "linear", kind: "tool" },
  { display: "Release work", insert: "workspace:ws-1", kind: "workspace" },
  { display: "Billing audit", insert: "session:bks-2", kind: "session" },
];

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  publishClientDataIdentity(null);
});

test("a private target asks for no services (tools=none) and offers no service rows", async () => {
  const calls: unknown[][] = [];
  const items = await fetchMentionPalette(
    "",
    {
      privateTarget: true,
      sessionId: "bks-private",
      user: "jaap",
      mcpServers: ["linear"],
    },
    async (...args) => {
      calls.push(args);
      return rows;
    },
  );
  expect(calls).toEqual([
    ["", "bks-private", "jaap", undefined, { tools: "none" }],
  ]);
  expect(items.map((item) => item.insert)).toEqual([
    "workspace:ws-1",
    "session:bks-2",
  ]);
});

test("a shared target keeps its pick and every service row (control)", async () => {
  const calls: unknown[][] = [];
  const items = await fetchMentionPalette(
    "lin",
    { privateTarget: false, user: "jaap", mcpServers: ["linear"] },
    async (...args) => {
      calls.push(args);
      return rows;
    },
  );
  expect(calls).toEqual([["lin", undefined, "jaap", ["linear"], undefined]]);
  expect(items).toEqual(rows);
});

test("the private request carries tools=none and no mcp scope; the shared one only its pick", async () => {
  const urls: string[] = [];
  publishClientDataIdentity({
    required: true,
    authenticated: true,
    githubAccountId: 11,
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ items: rows });
    },
    { preconnect: originalFetch.preconnect },
  );
  const privateItems = await fetchMentionPalette("", {
    privateTarget: true,
    mcpServers: ["linear", "slack"],
  });
  const sharedItems = await fetchMentionPalette("", {
    privateTarget: false,
    mcpServers: ["linear", "slack"],
  });
  expect(urls).toHaveLength(2);
  const [privateUrl, sharedUrl] = urls.map((url) => new URL(url, "http://x"));
  expect(privateUrl!.searchParams.get("tools")).toBe("none");
  expect(privateUrl!.searchParams.getAll("mcp")).toEqual([]);
  expect(sharedUrl!.searchParams.get("tools")).toBeNull();
  expect(sharedUrl!.searchParams.getAll("mcp")).toEqual(["linear", "slack"]);
  expect(privateItems.some((item) => item.kind === "tool")).toBe(false);
  expect(sharedItems.some((item) => item.kind === "tool")).toBe(true);
});

test("scope and row helpers", () => {
  expect(mentionPaletteScope(true, ["linear"])).toEqual({
    options: { tools: "none" },
  });
  expect(mentionPaletteScope(false, ["linear"])).toEqual({
    mcpServers: ["linear"],
  });
  expect(mentionPaletteScope(false, undefined)).toEqual({
    mcpServers: undefined,
  });
  expect(withoutConnectedServices(rows).map((r) => r.kind)).toEqual([
    "workspace",
    "session",
  ]);
});
