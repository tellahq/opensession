/**
 * The web-fetch pieces worth pinning: the address guard, HTML extraction, and
 * the cache/handle contract that keeps a long page out of the transcript.
 *
 * The guard gets the most attention because it is the part that fails
 * dangerously rather than visibly: the caller is a model acting on text it
 * read somewhere, so a URL is an untrusted input, and a redirect is a second
 * untrusted input the first one chose.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DIR = mkdtempSync(join(tmpdir(), "web-fetch-"));
const PREV = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = DIR;

const {
  assertFetchableUrl,
  decodeEntities,
  fetchWeb,
  htmlToText,
  isBlockedAddress,
  readFetched,
} = await import("./web-fetch");

beforeEach(() => {
  process.env.OPENSESSION_STATE_DIR = DIR;
});

afterAll(() => {
  if (PREV === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = PREV;
  rmSync(DIR, { recursive: true, force: true });
});

describe("isBlockedAddress", () => {
  test("blocks the address ranges an SSRF actually aims at", () => {
    for (const ip of [
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT / tailnet
      "100.127.255.255",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1", // v4-mapped loopback
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  test("allows ordinary public addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "140.82.121.4",
      "172.32.0.1",
      "100.63.255.255",
      "2606:4700::1111",
    ]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  test("the 172.16/12 boundary is not off by one", () => {
    expect(isBlockedAddress("172.15.255.255")).toBe(false);
    expect(isBlockedAddress("172.16.0.0")).toBe(true);
    expect(isBlockedAddress("172.31.255.255")).toBe(true);
    expect(isBlockedAddress("172.32.0.0")).toBe(false);
  });
});

describe("assertFetchableUrl", () => {
  test("refuses a non-http scheme", async () => {
    await expect(assertFetchableUrl("file:///etc/passwd")).rejects.toThrow(
      /http/i,
    );
    await expect(assertFetchableUrl("ftp://example.com")).rejects.toThrow(
      /http/i,
    );
  });

  test("refuses a literal private address without needing DNS", async () => {
    await expect(
      assertFetchableUrl("http://127.0.0.1:3850/api/sessions"),
    ).rejects.toThrow(/private/i);
    await expect(
      assertFetchableUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/private/i);
    await expect(assertFetchableUrl("http://[::1]/")).rejects.toThrow(
      /private/i,
    );
  });

  test("refuses reserved private NAMES, which never resolve publicly", async () => {
    for (const url of [
      "http://localhost:3850/",
      "http://foo.localhost/",
      "http://db.internal/",
      "http://router.home.arpa/",
    ]) {
      await expect(assertFetchableUrl(url)).rejects.toThrow(/private/i);
    }
  });

  test("rejects a malformed URL rather than guessing at one", async () => {
    await expect(assertFetchableUrl("not a url")).rejects.toThrow(/not a url/i);
  });
});

describe("htmlToText", () => {
  test("drops chrome and script content, keeps prose", async () => {
    const { text } = await htmlToText(
      `<html><head><style>body{color:red}</style></head><body>
			 <nav>Home About Contact</nav>
			 <script>window.tracking = 1</script>
			 <p>The actual sentence.</p>
			 <footer>Copyright</footer></body></html>`,
    );
    expect(text).toContain("The actual sentence.");
    expect(text).not.toContain("window.tracking");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("Home About Contact");
    expect(text).not.toContain("Copyright");
  });

  test("reads the title", async () => {
    const { title } = await htmlToText(
      "<html><head><title>  A Page  </title></head><body>x</body></html>",
    );
    expect(title).toBe("A Page");
  });

  test("block elements become line breaks, so paragraphs do not run together", async () => {
    const { text } = await htmlToText("<p>First.</p><p>Second.</p>");
    expect(text).toBe("First.\nSecond.");
  });

  test("collapses runaway whitespace instead of shipping it as tokens", async () => {
    const { text } = await htmlToText("<p>a</p>\n\n\n\n\n<p>b</p>");
    expect(text).not.toMatch(/\n{3,}/);
  });
});

describe("decodeEntities", () => {
  test("named, decimal and hex entities", () => {
    expect(decodeEntities("a &amp; b")).toBe("a & b");
    expect(decodeEntities("&lt;tag&gt;")).toBe("<tag>");
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
    expect(decodeEntities("&nbsp;")).toBe(" ");
  });

  test("leaves an unknown entity alone rather than mangling it", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });
});

describe("fetch → handle → read", () => {
  /** A local server would be blocked by the address guard (correctly), so the
   *  cache/handle contract is exercised through a stubbed fetch. */
  async function withStubbedFetch<T>(
    body: string,
    contentType: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const real = globalThis.fetch;
    // `as unknown as` because Bun's fetch carries a `preconnect` property a
    // plain function stub cannot satisfy.
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": contentType },
      })) as unknown as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  }

  const LONG = `<html><head><title>Docs</title></head><body><p>${"filler ".repeat(2000)}</p><p>The needle is here.</p></body></html>`;

  test("returns a bounded head plus a handle, not the whole page", async () => {
    const page = await withStubbedFetch(LONG, "text/html", () =>
      fetchWeb("https://example.com/docs", { refresh: true, headChars: 500 }),
    );
    expect(page.head.length).toBe(500);
    expect(page.truncated).toBe(true);
    expect(page.chars).toBeGreaterThan(5000);
    expect(page.title).toBe("Docs");
    expect(page.handle).toMatch(/^web_[0-9a-f]{16}$/);
  });

  test("read_page finds a passage the head never showed", async () => {
    const page = await withStubbedFetch(LONG, "text/html", () =>
      fetchWeb("https://example.com/docs2", { refresh: true, headChars: 300 }),
    );
    expect(page.head).not.toContain("needle");
    const slice = readFetched(page.handle, { find: "needle" });
    expect(slice.matches).toBe(1);
    expect(slice.text).toContain("The needle is here.");
  });

  test("a search that misses says so instead of returning the page", () => {
    const handle = "web_0000000000000000";
    expect(() => readFetched(handle)).toThrow(/expired|never fetched/i);
  });

  test("offset reads walk the body without re-fetching", async () => {
    const page = await withStubbedFetch(
      "0123456789".repeat(100),
      "text/plain",
      () =>
        fetchWeb("https://example.com/plain", {
          refresh: true,
          headChars: 200,
        }),
    );
    const slice = readFetched(page.handle, { offset: 500, limit: 200 });
    expect(slice.offset).toBe(500);
    expect(slice.text.length).toBe(200);
    expect(slice.truncated).toBe(true);
  });

  test("a second fetch of the same URL is served from disk", async () => {
    let calls = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("<p>cached body</p>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    try {
      await fetchWeb("https://example.com/cacheme", { refresh: true });
      await fetchWeb("https://example.com/cacheme");
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("raw mode keeps the markup, text mode strips it", async () => {
    const raw = await withStubbedFetch("<p>hi</p>", "text/html", () =>
      fetchWeb("https://example.com/raw", { refresh: true, mode: "raw" }),
    );
    expect(raw.head).toContain("<p>");
    const text = await withStubbedFetch("<p>hi</p>", "text/html", () =>
      fetchWeb("https://example.com/text", { refresh: true, mode: "text" }),
    );
    expect(text.head).not.toContain("<p>");
    expect(text.head).toContain("hi");
  });
});
