import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import type { UnifiedSession } from "./types";

const scratch = mkdtempSync(join(tmpdir(), "opensession-social-card-"));
const previousStateDir = process.env.OPENSESSION_STATE_DIR;
const previousUiBase = process.env.OPENSESSION_UI_BASE;
const previousCardBase = process.env.OPENSESSION_SESSION_CARD_BASE;
const previousCardSecret = process.env.OPENSESSION_SESSION_CARD_SECRET;
process.env.OPENSESSION_STATE_DIR = scratch;
process.env.OPENSESSION_UI_BASE = "https://os.example.test";
process.env.OPENSESSION_SESSION_CARD_BASE = "https://media.example.test";
process.env.OPENSESSION_SESSION_CARD_SECRET =
  "test-session-social-card-secret-32-bytes";

const {
  renderSessionSocialCard,
  sessionHtmlWithSocialMeta,
  sessionSocialCardData,
  sessionSocialCardPublicRoutes,
  sessionSocialCardSvg,
  sessionSocialCardUrl,
  hasUsableSessionShot,
  socialSessionIdFromPath,
} = await import("./session-social-card");
const { invalidateSessionsCache } = await import("./session-cache");
const { transcriptStore } = await import("./transcript-store");

const signedRouteSessionId = "slack-C123-1719860000.000000";
const sessionsDir = join(scratch, ".opensession-sessions");
const uploadsDir = join(sessionsDir, "uploads", "social-card-tests");
mkdirSync(uploadsDir, { recursive: true });
const imageBytes = await sharp({
  create: {
    width: 640,
    height: 360,
    channels: 4,
    background: "#92b8d9",
  },
})
  .png()
  .toBuffer();
function testImage(name: string): string {
  const path = join(uploadsDir, name);
  writeFileSync(path, imageBytes);
  return path;
}
function mediaRef(path: string): string {
  return `/media?path=${encodeURIComponent(path)}`;
}
writeFileSync(
  join(sessionsDir, `${signedRouteSessionId}.json`),
  JSON.stringify({
    id: signedRouteSessionId,
    claudeSessionId: null,
    title: "Signed Slack social card",
    createdBy: "Test Person",
    createdAt: "2026-08-18T12:00:00Z",
    lastActivity: "2026-08-18T12:00:00Z",
    mode: "ask",
  }),
);
invalidateSessionsCache();

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
  rmSync(scratch, { recursive: true, force: true });
});

function session(patch: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: "sess-social-1",
    title: "Ship dynamic social cards",
    createdBy: "Test Person",
    startedBy: "Test",
    model: "pi/openai/gpt-5.6-sol",
    repo: "opensession",
    mode: "code",
    lastActivity: "2026-08-18T12:00:00Z",
    ...patch,
  } as UnifiedSession;
}

describe("session social card", () => {
  test("normalizes the title and external preview metadata", async () => {
    const data = await sessionSocialCardData(session());
    expect(data).toMatchObject({
      title: "Ship dynamic social cards",
      owner: "Test Person",
      repo: "opensession",
    });
    expect(data).not.toHaveProperty("model");
    expect(data).not.toHaveProperty("accent");
  });

  test("stacks walkthrough, featured, then person-attached screenshots", async () => {
    const opening = testImage("opening.png");
    const featured = testImage("featured.png");
    const walkthrough = testImage("walkthrough.png");
    const sessionId = "sess-social-shot-priority";
    await transcriptStore().appendTranscriptEvents(sessionId, [
      {
        id: "opening",
        type: "user",
        content: "Please fix this",
        timestamp: "2026-08-18T12:00:00Z",
        images: [mediaRef(opening)],
      },
      {
        id: "featured",
        type: "tool_result",
        content: "Finished preview",
        timestamp: "2026-08-18T12:01:00Z",
        images: [mediaRef(featured)],
        featuredMedia: [mediaRef(featured)],
      },
    ]);

    expect(
      (
        await sessionSocialCardData(session({ id: sessionId }), {
          includeShot: true,
        })
      ).shots,
    ).toEqual([featured, opening]);
    expect(
      (
        await sessionSocialCardData(
          session({
            id: sessionId,
            walkthrough: {
              summary: "A clearer session card.",
              publishedAt: "2026-08-18T12:02:00Z",
              shots: [{ after: walkthrough }],
            },
          }),
          { includeShot: true },
        )
      ).shots,
    ).toEqual([walkthrough, featured, opening]);

    const personOnlyId = "sess-social-person-shot";
    await transcriptStore().appendTranscriptEvents(personOnlyId, [
      {
        id: "person-shot",
        type: "user",
        content: "This screenshot explains the task",
        timestamp: "2026-08-18T12:00:00Z",
        images: [mediaRef(opening)],
      },
      {
        id: "ordinary-tool-image",
        type: "tool_result",
        content: "A file the agent merely read",
        timestamp: "2026-08-18T12:01:00Z",
        images: [mediaRef(featured)],
      },
    ]);
    expect(
      (
        await sessionSocialCardData(session({ id: personOnlyId }), {
          includeShot: true,
        })
      ).shots,
    ).toEqual([opening]);
  });

  test("restores transcript-owned chat screenshots from bounded rows", async () => {
    const sessionId = "sess-social-data-shot";
    const dataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
    await transcriptStore().appendTranscriptEvents(sessionId, [
      {
        id: "data-shot",
        type: "user",
        content: "x".repeat(40_000),
        timestamp: "2026-08-18T12:00:00Z",
        images: [dataUrl],
      },
    ]);
    const wire = transcriptStore().readTail(sessionId).entries[0];
    expect(wire.images).toEqual(["os-blob:data-shot/0"]);
    expect(
      (
        await sessionSocialCardData(session({ id: sessionId }), {
          includeShot: true,
        })
      ).shots?.[0],
    ).toBe(dataUrl);
  });

  test("draws the screenshot and nothing else", async () => {
    const svg = sessionSocialCardSvg([
      { dataUrl: "data:image/png;base64,primary", width: 640, height: 360 },
    ]);
    // The title, the person and the repo travel with the link itself, so no
    // text is drawn on the card.
    expect(svg).not.toContain("<text");
    expect(svg).not.toContain("font-size");
    // The frame extends below the 352px viewport, so its lower edge is cut off
    // instead of floating above a shelf of white space.
    expect(svg).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="352"',
    );
    // There is no outer card surface. Transparent pixels carry only the
    // screenshot's shadow, while the screenshot itself gets a quiet outline.
    expect(svg).not.toContain('<rect width="720" height="352"');
    expect(svg).toContain(
      '<image href="data:image/png;base64,primary" x="40" y="30" width="640" height="360"',
    );
    expect(svg).toContain(
      'fill="none" stroke="#000000" stroke-opacity="0.1" stroke-width="1"',
    );
    expect(svg).not.toContain('transform="rotate(');
    expect(svg).toContain('stdDeviation="22"');
    expect(svg).toContain('result="ambient"');
    expect(svg).toContain('result="lift"');
    expect(svg).toContain('result="contact"');
    expect(svg).not.toContain("gradient");
  });

  test("fans a second screenshot up from behind the first", async () => {
    const svg = sessionSocialCardSvg([
      { dataUrl: "data:image/png;base64,primary", width: 640, height: 360 },
      { dataUrl: "data:image/png;base64,secondary", width: 640, height: 360 },
      { dataUrl: "data:image/png;base64,ignored", width: 640, height: 360 },
    ]);
    // The crop follows the rotated side and top corners, then deliberately cuts
    // through the bottom so the fan rises out of the image boundary.
    expect(svg).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" width="859" height="406"',
    );
    expect(svg).toContain(
      '<image href="data:image/png;base64,primary" x="166" y="43" width="640" height="360"',
    );
    expect(svg).toContain(
      '<image href="data:image/png;base64,secondary" x="70" y="57" width="640" height="360"',
    );
    expect(svg).not.toContain("ignored");
    expect(svg).toContain('transform="rotate(2 486 403)"');
    expect(svg).toContain('transform="rotate(-5 390 417)"');
    expect(svg).toContain(
      '<clipPath id="shotClip1" clipPathUnits="userSpaceOnUse"><path d="M98.00 57.00L682.00 57.00',
    );
  });

  test("has no card at all without a usable screenshot", async () => {
    expect(sessionSocialCardSvg([])).toBe("");
    expect(
      await renderSessionSocialCard(await sessionSocialCardData(session())),
    ).toBeNull();
    expect(
      await hasUsableSessionShot(await sessionSocialCardData(session())),
    ).toBe(false);
  });

  test("renders a crisp 2x PNG of one screenshot", async () => {
    const shot = testImage("render.png");
    const png = await renderSessionSocialCard({
      title: "Ship dynamic social cards",
      owner: "Test Person",
      shots: [shot],
    });
    expect(png).not.toBeNull();
    const metadata = await sharp(png!).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1440);
    expect(metadata.height).toBe(704);
    expect(metadata.hasAlpha).toBe(true);
  });

  test("preserves a landscape screenshot's native aspect ratio", async () => {
    const landscape = join(uploadsDir, "landscape.png");
    await sharp({
      create: {
        width: 800,
        height: 500,
        channels: 4,
        background: "#d92d20",
      },
    })
      .png()
      .toFile(landscape);
    const png = await renderSessionSocialCard({
      title: "Keep the original shape",
      owner: "Test Person",
      shots: [landscape],
    });
    expect(png).not.toBeNull();
    const metadata = await sharp(png!).metadata();
    expect(metadata.width).toBe(1440);
    expect(metadata.height).toBe(784);
  });

  test("preserves a portrait screenshot's native aspect ratio", async () => {
    const portrait = join(uploadsDir, "portrait.png");
    await sharp({
      create: {
        width: 400,
        height: 800,
        channels: 4,
        background: "#d92d20",
      },
    })
      .png()
      .toFile(portrait);
    const png = await renderSessionSocialCard({
      title: "Show the whole screenshot",
      owner: "Test Person",
      shots: [portrait],
    });
    expect(png).not.toBeNull();
    const { data, info } = await sharp(png!)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(800);
    expect(info.height).toBe(1264);
    const pixel = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return [...data.subarray(offset, offset + 3)];
    };
    // The complete 1:2 source remains 1:2 inside the card instead of being cropped.
    expect(pixel(400, 420)).toEqual([217, 45, 32]);
    expect(pixel(400, 1100)).toEqual([217, 45, 32]);
    expect(info.channels).toBe(4);
  });

  test("drops ultra-wide card captures instead of nesting a card inside itself", async () => {
    const nestedCard = join(uploadsDir, "nested-card.png");
    await sharp({
      create: {
        width: 1600,
        height: 600,
        channels: 4,
        background: "#d92d20",
      },
    })
      .png()
      .toFile(nestedCard);
    const data = {
      title: "Do not recurse",
      owner: "Test Person",
      shots: [nestedCard],
    };
    expect(await hasUsableSessionShot(data)).toBe(false);
    expect(await renderSessionSocialCard(data)).toBeNull();
  });

  test("injects large-image metadata into the session HTML", async () => {
    const source = `<head>
<title>Open Session</title>
<meta property="og:type" content="website" />
<meta property="og:title" content="Open Session" />
<meta property="og:image" content="/icon.png" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="Open Session" />
<meta name="twitter:image" content="/icon.png" />
</head>`;
    const output = sessionHtmlWithSocialMeta(
      source,
      session(),
      "/session/sess-social-1",
    );
    expect(output).toContain(
      "<title>Ship dynamic social cards · Open Session</title>",
    );
    expect(output).toContain('content="summary_large_image"');
    expect(output).toMatch(
      /content="https:\/\/media\.example\.test\/session-card\/sess-social-1\/[A-Za-z0-9_-]{32}\.png\?v=26"/,
    );
    expect(output).toContain(
      'property="og:url" content="https://os.example.test/session/sess-social-1"',
    );
    // The card is cropped to its screenshots, so it has no fixed dimensions.
    expect(output).not.toContain("og:image:width");
    expect(output).not.toContain("og:image:height");
  });

  test("parses both session link shapes", async () => {
    expect(socialSessionIdFromPath("/session/sess-social-1")).toBe(
      "sess-social-1",
    );
    expect(
      socialSessionIdFromPath("/workspace/ws-1/session/sess-social-1"),
    ).toBe("sess-social-1");
    expect(socialSessionIdFromPath("/settings")).toBeNull();
    expect(sessionSocialCardUrl("sess-social-1")).toMatch(
      /^https:\/\/media\.example\.test\/session-card\/sess-social-1\/[A-Za-z0-9_-]{32}\.png\?v=26$/,
    );
  });

  test("signs ids containing Slack timestamp dots", async () => {
    expect(sessionSocialCardUrl("slack-C123-1719860000.000000")).toMatch(
      /^https:\/\/media\.example\.test\/session-card\/slack-C123-1719860000\.000000\/[A-Za-z0-9_-]{32}\.png\?v=26$/,
    );
  });

  test("public image routes reject malformed capability paths", async () => {
    const route = sessionSocialCardPublicRoutes().get("GET /session-card/*");
    expect(route).toBeDefined();
    const response = await route!(
      new Request("https://media.example.test/session-card/not-valid.svg"),
      new URL("https://media.example.test/session-card/not-valid.svg"),
    );
    expect(response.status).toBe(404);
  });

  test("answers 404 for a session with no screenshot to show", async () => {
    const route = sessionSocialCardPublicRoutes().get("GET /session-card/*")!;
    const url = new URL(sessionSocialCardUrl(signedRouteSessionId));
    const response = await route(new Request(url), url);
    expect(response.status).toBe(404);
  });

  test("serves a signed Slack-style session id", async () => {
    await transcriptStore().appendTranscriptEvents(signedRouteSessionId, [
      {
        id: "signed-shot",
        type: "user",
        content: "Here is the screen",
        timestamp: "2026-08-18T12:00:00Z",
        images: [mediaRef(testImage("signed.png"))],
      },
    ]);
    const route = sessionSocialCardPublicRoutes().get("GET /session-card/*")!;
    const url = new URL(sessionSocialCardUrl(signedRouteSessionId));
    const response = await route(new Request(url), url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const metadata = await sharp(await response.arrayBuffer()).metadata();
    expect(metadata.width).toBe(1440);
    expect(metadata.height).toBe(704);
  });

  test("ignores an unrecognized shape parameter", async () => {
    const route = sessionSocialCardPublicRoutes().get("GET /session-card/*")!;
    const url = new URL(`${sessionSocialCardUrl(signedRouteSessionId)}&s=tall`);
    const response = await route(new Request(url), url);
    expect(response.status).toBe(200);
    const metadata = await sharp(await response.arrayBuffer()).metadata();
    expect(metadata.width).toBe(1440);
    expect(metadata.height).toBe(704);
  });

  test("rejects an invalid HMAC before resolving the session", async () => {
    const route = sessionSocialCardPublicRoutes().get("GET /session-card/*")!;
    const valid = new URL(sessionSocialCardUrl(signedRouteSessionId));
    const invalid = new URL(
      valid.href.replace(
        /[A-Za-z0-9_-]{32}\.png(?=\?)/,
        `${"A".repeat(32)}.png`,
      ),
    );
    const response = await route(new Request(invalid), invalid);
    expect(response.status).toBe(404);
  });
});
