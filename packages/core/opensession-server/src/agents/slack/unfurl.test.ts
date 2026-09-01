import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import type { UnifiedSession } from "../../server/types";

// Unfurl modules resolve their state directory and UI host at import.
const scratch = mkdtempSync(join(tmpdir(), "opensession-unfurl-"));
const previousStateDir = process.env.OPENSESSION_STATE_DIR;
const previousUiBase = process.env.OPENSESSION_UI_BASE;
const previousCardBase = process.env.OPENSESSION_SESSION_CARD_BASE;
const previousCardSecret = process.env.OPENSESSION_SESSION_CARD_SECRET;
process.env.OPENSESSION_STATE_DIR = scratch;
process.env.OPENSESSION_UI_BASE = "https://os.example.test";
process.env.OPENSESSION_SESSION_CARD_BASE = "https://media.example.test";
process.env.OPENSESSION_SESSION_CARD_SECRET =
  "test-session-social-card-secret-32-bytes";

const { cardTitle, handleLinkShared, unfurlForSession } =
  await import("./unfurl");
const { UPLOADS_DIR } = await import("../../server/uploads");
mkdirSync(UPLOADS_DIR, { recursive: true });
const uploadsDir = mkdtempSync(join(UPLOADS_DIR, "unfurl-tests-"));
const screenshot = join(uploadsDir, "screenshot.png");
const recursiveCard = join(uploadsDir, "recursive-card.png");
await Promise.all([
  sharp({
    create: {
      width: 1280,
      height: 720,
      channels: 4,
      background: "#92b8d9",
    },
  })
    .png()
    .toFile(screenshot),
  sharp({
    create: {
      width: 1600,
      height: 600,
      channels: 4,
      background: "#ffffff",
    },
  })
    .png()
    .toFile(recursiveCard),
]);

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  if (previousUiBase === undefined) delete process.env.OPENSESSION_UI_BASE;
  else process.env.OPENSESSION_UI_BASE = previousUiBase;
  if (previousCardBase === undefined)
    delete process.env.OPENSESSION_SESSION_CARD_BASE;
  else process.env.OPENSESSION_SESSION_CARD_BASE = previousCardBase;
  if (previousCardSecret === undefined)
    delete process.env.OPENSESSION_SESSION_CARD_SECRET;
  else process.env.OPENSESSION_SESSION_CARD_SECRET = previousCardSecret;
  rmSync(uploadsDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("unfurlForSession", () => {
  test("shows a screenshot-only card below the linked title", async () => {
    const unfurl = await unfurlForSession(
      session({
        id: "sess-card",
        title: "Ship the card",
        createdBy: "Kent",
        model: "pi/openai/gpt-5.6-sol",
        walkthrough: {
          summary: "A visual walkthrough.",
          publishedAt: "2026-08-21T12:00:00Z",
          shots: [{ after: screenshot }],
        },
      }),
      "https://os.example.test/session/sess-card",
    );
    expect(unfurl.blocks).toContainEqual({
      type: "image",
      image_url: expect.stringMatching(
        /^https:\/\/media\.example\.test\/session-card\/sess-card\/[A-Za-z0-9_-]{32}\.png\?v=26$/,
      ),
      alt_text: "Ship the card, Open Session preview",
    });
    // Slack owns the linked title. The image below contains screenshots only.
    expect(unfurl.blocks.map((block: any) => block.type)).toEqual([
      "section",
      "image",
      "context",
    ]);
    expect(unfurl.blocks[0].text.text).toBe(
      "*<https://os.example.test/session/sess-card|Ship the card>*",
    );
    expect(unfurl.blocks.some((b: any) => b.accessory)).toBe(false);
    expect(JSON.stringify(unfurl.blocks)).not.toContain("gpt-5.6-sol");
  });

  test("replaces an empty image card with the linked title", async () => {
    for (const shots of [[], [{ after: recursiveCard }]]) {
      const unfurl = await unfurlForSession(
        session({
          id: "sess-card",
          title: "Ship the card",
          createdBy: "Kent",
          walkthrough: {
            summary: "No useful screenshot.",
            publishedAt: "2026-08-21T12:00:00Z",
            shots,
          },
        }),
        "https://os.example.test/session/sess-card",
      );
      expect(unfurl.blocks.map((block: any) => block.type)).toEqual([
        "section",
        "context",
      ]);
      expect(unfurl.blocks[0].text.text).toBe(
        "*<https://os.example.test/session/sess-card|Ship the card>*",
      );
      expect(unfurl.blocks.some((block: any) => block.type === "image")).toBe(
        false,
      );
    }
  });

  test("shows only the person, repo and freshness below the card", async () => {
    const unfurl = await unfurlForSession(
      session({
        id: "sess-card",
        title: "Ship the card",
        createdBy: "Kent",
        repo: "opensession",
        branch: "main",
        mode: "code",
        workspaceName: "Slack previews",
        walkthrough: {
          summary: "A summary Slack should not repeat below the image.",
          publishedAt: "2026-08-21T12:00:00Z",
          shots: [],
        },
        lastRunError: { message: "needs input", at: "2026-08-21T12:00:00Z" },
      }),
      "https://os.example.test/session/sess-card",
    );
    const context = unfurl.blocks.find((b: any) => b.type === "context");
    expect(context?.elements[0].text).toMatch(
      /^Kent  ·  opensession  ·  updated \d+[smhd] ago$/,
    );
    const json = JSON.stringify(unfurl.blocks);
    expect(json).not.toContain("Slack previews");
    expect(json).not.toContain("A summary Slack should not repeat");
    expect(json).not.toContain("Needs input");
    expect(json).not.toContain("`main`");
    expect(json).not.toContain("code");
  });

  test("does not substitute the product name for a missing person", async () => {
    const unfurl = await unfurlForSession(
      session({ id: "sess-card", title: "Ship the card", repo: "opensession" }),
      "https://os.example.test/session/sess-card",
    );
    const context = unfurl.blocks.find((b: any) => b.type === "context");
    expect(context?.elements[0].text).toMatch(
      /^opensession  ·  updated \d+[smhd] ago$/,
    );
    expect(context?.elements[0].text).not.toContain("Open Session");
  });
});

describe("handleLinkShared", () => {
  test("sends the generated attachment to chat.unfurl", async () => {
    const calls: Array<{ method: string; params: Record<string, any> }> = [];
    const s = session({
      id: "sess-card",
      title: "Ship the card",
      createdBy: "Kent",
    });
    await handleLinkShared(
      {
        channel: "C1",
        message_ts: "1700000000.000100",
        links: [{ url: "https://os.example.test/session/sess-card" }],
      },
      {
        findSession: async () => s,
        unfurl: async (method, params) => {
          calls.push({ method, params });
          return { ok: true };
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("chat.unfurl");
    expect(calls[0].params.channel).toBe("C1");
    expect(Object.keys(calls[0].params.unfurls)).toEqual([
      "https://os.example.test/session/sess-card",
    ]);
  });

  test("rejects when Slack refuses the attachment", async () => {
    const s = session({ id: "sess-card", title: "Ship the card" });
    expect(
      handleLinkShared(
        {
          channel: "C1",
          message_ts: "1700000000.000100",
          links: [{ url: "https://os.example.test/session/sess-card" }],
        },
        {
          findSession: async () => s,
          unfurl: async () => ({ ok: false, error: "cannot_parse_attachment" }),
        },
      ),
    ).rejects.toThrow("Slack chat.unfurl failed: cannot_parse_attachment");
  });
});

function session(patch: Partial<UnifiedSession>): UnifiedSession {
  return {
    id: "sess-1",
    lastActivity: new Date().toISOString(),
    ...patch,
  } as UnifiedSession;
}

describe("cardTitle", () => {
  test("uses the session title even when it belongs to a workspace", () => {
    expect(
      cardTitle(session({ title: "Fix the seek bar", workspaceId: "ws-1" })),
    ).toEqual({ title: "Fix the seek bar" });
  });

  test("uses the session title when there is no workspace", () => {
    expect(cardTitle(session({ title: "Triage the ticket" }))).toEqual({
      title: "Triage the ticket",
    });
  });

  test("falls back when the workspace id no longer resolves", () => {
    expect(
      cardTitle(
        session({ title: "Triage the ticket", workspaceId: "ws-gone" }),
      ),
    ).toEqual({ title: "Triage the ticket" });
  });

  test("falls back to the session id when the session is untitled", () => {
    expect(cardTitle(session({ id: "sess-42" }))).toEqual({ title: "sess-42" });
  });
});
