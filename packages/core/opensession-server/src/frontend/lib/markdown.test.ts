import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  renderMarkdown,
  renderPrCommentMarkdown,
  onSessionTitleResolutionRequested,
  resetResolvedSessionTitles,
  setKnownPeople,
  setKnownRepoPrStates,
  setKnownRepos,
  setKnownPrStates,
  setResolvedSessionTitles,
  setSessionTitles,
} from "./markdown";

afterEach(() => {
  setSessionTitles([]);
  resetResolvedSessionTitles();
  setKnownRepos([]);
  setKnownPrStates([]);
  setKnownRepoPrStates([]);
});

describe("renderMarkdown session links", () => {
  it("turns a session-id codespan into a link", () => {
    const html = renderMarkdown(
      "Delegated to `bks-019f24b5-f31d-7000-a48f-31a9e829c4ae` reporting back.",
    );
    expect(html).toContain('class="session-link"');
    expect(html).toContain(
      'data-session-id="bks-019f24b5-f31d-7000-a48f-31a9e829c4ae"',
    );
    // not rendered as a plain <code> chip
    expect(html).not.toContain(
      "<code>bks-019f24b5-f31d-7000-a48f-31a9e829c4ae</code>",
    );
  });

  it("links a bare (un-backticked) uuidv7 session id in prose", () => {
    const html = renderMarkdown(
      "Started session bks-019f24b5-daa6-7000-8231-6c7ff13672ae as a worker.",
    );
    expect(html).toContain('class="session-link"');
    expect(html).toContain(
      'data-session-id="bks-019f24b5-daa6-7000-8231-6c7ff13672ae"',
    );
  });

  it("links an `os-` id, the prefix minted since the rename", () => {
    const codespan = renderMarkdown(
      "Delegated to `os-019fd30a-785b-7000-ad89-9c2fb5b74a19` reporting back.",
    );
    expect(codespan).toContain(
      'data-session-id="os-019fd30a-785b-7000-ad89-9c2fb5b74a19"',
    );
    const bare = renderMarkdown(
      "Started session os-019fd30a-785b-7000-ad89-9c2fb5b74a19 as a worker.",
    );
    expect(bare).toContain(
      'data-session-id="os-019fd30a-785b-7000-ad89-9c2fb5b74a19"',
    );
    const url = renderMarkdown(
      "See [it](http://127.0.0.1:3850/session/os-019fd30a-785b-7000-ad89-9c2fb5b74a19).",
    );
    expect(url).toContain(
      'data-session-id="os-019fd30a-785b-7000-ad89-9c2fb5b74a19"',
    );
    expect(url).not.toContain("target=");
  });

  it("keeps `os-` strict: only a uuid-shaped id, never a codespan that starts with it", () => {
    // `bks-` was distinctive enough for the loose slug shape; `os-` is two
    // letters, so anything but the minted `os-<uuidv7>` stays a code chip.
    const html = renderMarkdown("Tagged `os-release-2026` for the cut.");
    expect(html).toContain("<code>os-release-2026</code>");
    expect(html).not.toContain("session-link");
  });

  it("still resolves a legacy /backstage-prefixed session URL in-app", () => {
    // Pre-rename links live on in old transcripts; the server 301s them, but
    // the chip has to recognize the path to keep the click client-side.
    const html = renderMarkdown(
      "See [this](http://127.0.0.1:3850/backstage/session/bks-019f9608-ab20-7000-b98e-4de52d5fe436).",
    );
    expect(html).toContain(
      'data-session-id="bks-019f9608-ab20-7000-b98e-4de52d5fe436"',
    );
    expect(html).not.toContain("target=");
  });

  it("leaves ordinary codespans as code", () => {
    const html = renderMarkdown("Run `bun test` to check.");
    expect(html).toContain("<code>bun test</code>");
    expect(html).not.toContain("session-link");
  });

  it("does not misfire on non-session text", () => {
    const html = renderMarkdown("The bks-abbreviation is fine here.");
    expect(html).not.toContain("session-link");
  });

  it("renders an OS1 session URL as an in-app session link (no new tab)", () => {
    const html = renderMarkdown(
      "See [this session](http://127.0.0.1:3850/session/bks-019f9608-ab20-7000-b98e-4de52d5fe436).",
    );
    expect(html).toContain('class="session-link"');
    expect(html).toContain(
      'data-session-id="bks-019f9608-ab20-7000-b98e-4de52d5fe436"',
    );
    expect(html).toContain(
      '<span class="session-link-label">this session</span>',
    );
    expect(html).not.toContain("target=");
  });

  it("labels a pasted (auto-linked) session URL with just the session id", () => {
    const url =
      "http://127.0.0.1:3850/workspace/ws-28712580-a369-4d58-996b-f8c23e523ed1/session/bks-019f9608-ab20-7000-b98e-4de52d5fe436";
    const html = renderMarkdown(`${url} shows no right sidebar.`);
    expect(html).toContain(
      'data-session-id="bks-019f9608-ab20-7000-b98e-4de52d5fe436"',
    );
    // the ~90-char URL is the href, never the chip's (nowrap) label
    expect(html).toContain(
      '<span class="session-link-label">bks-019f9608…</span>',
    );
    expect(html).toContain(`href="${url}"`);
    expect(html).not.toContain(`>${url}</a>`);
  });

  it("keeps an explicit link label on a session URL", () => {
    const html = renderMarkdown(
      "See [the worker](http://127.0.0.1:3850/session/bks-019f9608-ab20-7000-b98e-4de52d5fe436).",
    );
    expect(html).toContain(
      '<span class="session-link-label">the worker</span>',
    );
  });

  it("keeps other internal OS1 links same-tab without a chip", () => {
    const html = renderMarkdown(
      "Open [automations](http://127.0.0.1:3850/automations).",
    );
    expect(html).not.toContain("target=");
    expect(html).not.toContain("session-link");
  });

  it("still opens external links in a new tab", () => {
    const html = renderMarkdown("See [GitHub](https://github.com/tella/x).");
    expect(html).toContain('target="_blank"');
  });

  it("opens a portal on the app hostname but another port in a new tab", () => {
    const html = renderMarkdown(
      "[Open Tella local preview](http://127.0.0.1:25779/videos)",
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe("renderMarkdown automation links", () => {
  const id = "auto-019fffbe-997a-7000-8d11-a27c0b1d8452";

  it("turns codespan and bare automation ids into settings links", () => {
    for (const source of [`Ran \`${id}\`.`, `Ran ${id}.`]) {
      const html = renderMarkdown(source);
      expect(html).toContain('class="automation-link"');
      expect(html).toContain(`data-automation-id="${id}"`);
      expect(html).toContain(`href="/automations/${id}"`);
      expect(html).toContain("auto-019fffbe…");
    }
  });

  it("turns an internal automation URL into the same chip", () => {
    const url = `http://127.0.0.1:3850/automations/${id}`;
    const html = renderMarkdown(`[Production Watchdog](${url})`);
    expect(html).toContain(`data-automation-id="${id}"`);
    expect(html).toContain(
      '<span class="automation-link-label">Production Watchdog</span>',
    );
    expect(html).not.toContain("target=");
  });

  it("keeps ordinary auto-prefixed code as code", () => {
    const html = renderMarkdown("Run `auto-fix` next.");
    expect(html).toContain("<code>auto-fix</code>");
    expect(html).not.toContain("automation-link");
  });

  it("does not link an id embedded in another word or path", () => {
    for (const source of [`not${id}`, `/tmp/${id}`]) {
      expect(renderMarkdown(source)).not.toContain("automation-link");
    }
  });
});

describe("session chip labels", () => {
  const id = "bks-019f24b5-f31d-7000-a48f-31a9e829c4ae";

  it("labels a chip with the session's title once registered", () => {
    setSessionTitles([[id, "Fix the sidebar hover states"]]);
    const html = renderMarkdown(`Delegated to \`${id}\`.`);
    expect(html).toContain(
      '<span class="session-link-label">Fix the sidebar hover states</span>',
    );
    expect(html).toContain(`data-session-id="${id}"`);
    // the full id stays reachable in the tooltip
    expect(html).toContain(`title="Open Fix the sidebar hover states (${id})"`);
    expect(html).not.toContain("data-session-label");
  });

  it("labels an alias with the canonical session's title", () => {
    const canonical = "os-019f24b5-f31d-7000-a48f-31a9e829c4ae";
    setSessionTitles([
      [canonical, "Fix the sidebar hover states", false, null, [id]],
    ]);
    expect(renderMarkdown(`Delegated to \`${id}\`.`)).toContain(
      '<span class="session-link-label">Fix the sidebar hover states</span>',
    );
  });

  it("requests an unknown reference for on-demand resolution", async () => {
    const requested: string[][] = [];
    const unsubscribe = onSessionTitleResolutionRequested((ids) =>
      requested.push(ids),
    );
    try {
      renderMarkdown(`Delegated to \`${id}\`.`);
      await Promise.resolve();
      expect(requested).toEqual([[id]]);
    } finally {
      unsubscribe();
    }
  });

  it("names archived references and replaces the conversation glyph", () => {
    setResolvedSessionTitles([
      {
        requestedId: id,
        title: "Fix the sidebar hover states",
        archived: true,
      },
    ]);
    const html = renderMarkdown(`Delegated to \`${id}\`.`);
    expect(html).toContain(
      '<span class="session-link-label">Fix the sidebar hover states</span>',
    );
    expect(html).toContain("data-session-archived");
    expect(html).toContain('<rect x="4" y="4.75" width="16" height="4"');
    expect(html).toContain(`(${id}) · archived`);
  });

  it("keeps the id fallback when the referenced session was deleted", async () => {
    setResolvedSessionTitles([{ requestedId: id, title: null }]);
    const requested: string[][] = [];
    const unsubscribe = onSessionTitleResolutionRequested((ids) =>
      requested.push(ids),
    );
    try {
      const html = renderMarkdown(`Delegated to \`${id}\`.`);
      await Promise.resolve();
      expect(html).toContain(
        '<span class="session-link-label">bks-019f24b5…</span>',
      );
      expect(requested).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("corrects an id chip that mounted before titles arrived", () => {
    const label = { textContent: "bks-019f24b5…" };
    const anchor = {
      dataset: { sessionId: id, sessionLabel: "id" },
      title: `Open session ${id}`,
      querySelector: () => label,
    };
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousDocument = globals.document;
    globals.document = {
      querySelectorAll: () => [anchor],
    };
    try {
      setSessionTitles([[id, "Fix the sidebar hover states"]]);
      expect(label.textContent).toBe("Fix the sidebar hover states");
      expect(anchor.dataset.sessionLabel).toBeUndefined();
      expect(anchor.title).toBe(`Open Fix the sidebar hover states (${id})`);
    } finally {
      if (previousDocument === undefined) delete globals.document;
      else globals.document = previousDocument;
    }
  });

  it("keeps the session's own title in the tooltip when it differs", () => {
    // The label names the workspace, so two chips into one workspace read the
    // same; the tip is where they come apart.
    setSessionTitles([
      [
        id,
        "Ship the movavi comparison page",
        false,
        "Review · PR #5778 Alternatives",
      ],
    ]);
    const html = renderMarkdown(`Delegated to \`${id}\`.`);
    expect(html).toContain(
      '<span class="session-link-label">Ship the movavi comparison page</span>',
    );
    expect(html).toContain(
      `title="Open Ship the movavi comparison page · Alternatives (${id})"`,
    );
  });

  it("leaves the tooltip alone when the session's title is the workspace's", () => {
    setSessionTitles([
      [
        id,
        "Fix the sidebar hover states",
        false,
        "Fix the sidebar hover states",
      ],
    ]);
    expect(renderMarkdown(`Delegated to \`${id}\`.`)).toContain(
      `title="Open Fix the sidebar hover states (${id})"`,
    );
  });

  it("falls back to a shortened id, marked for monospace", () => {
    const html = renderMarkdown(`Delegated to \`${id}\`.`);
    expect(html).toContain(
      '<span class="session-link-label">bks-019f24b5…</span>',
    );
    expect(html).toContain('data-session-label="id"');
    expect(html).toContain(`title="Open session ${id}"`);
  });

  it("cuts an `os-` id on a segment boundary, not mid-separator", () => {
    const html = renderMarkdown(
      "Delegated to `os-019fd30a-785b-7000-ad89-9c2fb5b74a19`.",
    );
    expect(html).toContain(
      '<span class="session-link-label">os-019fd30a…</span>',
    );
  });

  it("keeps short legacy slug ids whole", () => {
    const html = renderMarkdown("Delegated to `bks-worker-two`.");
    expect(html).toContain(
      '<span class="session-link-label">bks-worker-two</span>',
    );
  });

  it("truncates a long title", () => {
    setSessionTitles([
      [id, "A very long session title that would eat the whole sentence"],
    ]);
    const html = renderMarkdown(`Delegated to \`${id}\`.`);
    expect(html).toContain(
      '<span class="session-link-label">A very long session title that would…</span>',
    );
  });

  it("re-labels already-rendered markdown when titles arrive", () => {
    const src = `Delegated to \`${id}\`.`;
    expect(renderMarkdown(src)).toContain(
      '<span class="session-link-label">bks-019f24b5…</span>',
    );
    setSessionTitles([[id, "Late title"]]);
    expect(renderMarkdown(src)).toContain(
      '<span class="session-link-label">Late title</span>',
    );
  });

  it("drops the automation prefix a session was named after", () => {
    setSessionTitles([
      [id, "Simplify · PR #5517 Give floating surfaces a rounder corner"],
    ]);
    const html = renderMarkdown(`Delegated to \`${id}\`.`);
    expect(html).toContain(
      '<span class="session-link-label">Give floating surfaces a rounder corn…</span>',
    );
  });

  it("carries the glyph, and swaps it for the dot while that session runs", () => {
    setSessionTitles([[id, "Fix the sidebar hover states"]]);
    const idle = renderMarkdown(`Delegated to \`${id}\`.`);
    expect(idle).toContain('class="session-link-icon" aria-hidden="true"');
    expect(idle).not.toContain("data-session-running");

    setSessionTitles([[id, "Fix the sidebar hover states", true]]);
    // A different sentence, so this is a fresh render rather than the cached
    // one above: the running flag deliberately does not clear the cache, and
    // already-rendered chips are corrected in the DOM instead.
    const running = renderMarkdown(`Worker \`${id}\` is up.`);
    expect(running).toContain("data-session-running");
    expect(running).toContain("· running");
  });

  it("names a link whose label is only the session id", () => {
    setSessionTitles([[id, "Move shared sessions into PR branches"]]);
    const url = `http://127.0.0.1:3850/session/${id}`;
    // A label that repeats the id says nothing the chip does not already say,
    // at 39 characters. Both spellings agents write get the name instead.
    expect(renderMarkdown(`Session: [${id}](${url})`)).toContain(
      '<span class="session-link-label">Move shared sessions into PR branches</span>',
    );
    expect(renderMarkdown(`Session: [\`${id}\`](${url}) is done.`)).toContain(
      '<span class="session-link-label">Move shared sessions into PR branches</span>',
    );
  });

  it("shortens an id-only link label when no title is known", () => {
    const url = `http://127.0.0.1:3850/session/${id}`;
    const html = renderMarkdown(`Session: [${id}](${url})`);
    expect(html).toContain(
      '<span class="session-link-label">bks-019f24b5…</span>',
    );
    expect(html).toContain('data-session-label="id"');
  });

  it("ignores blank titles and unrelated sessions", () => {
    setSessionTitles([
      [id, "   "],
      ["bks-someone-else", "Other"],
    ]);
    expect(renderMarkdown(`Delegated to \`${id}\`.`)).toContain(
      '<span class="session-link-label">bks-019f24b5…</span>',
    );
  });
});

describe("renderMarkdown asset references", () => {
  const assets = {
    sessionId: "os-assets-test",
    assetPaths: ["report.html", "viz/index.html", "shots/before.png"],
  };

  it("links a current asset named directly in prose", () => {
    const html = renderMarkdown("Open `report.html` to inspect it.", assets);
    expect(html).toContain('class="asset-ref"');
    expect(html).toContain('data-asset-path="report.html"');
    expect(html).toContain('class="asset-ref-icon" aria-hidden="true"');
    expect(html).toContain(
      '<span class="asset-ref-label"><code>report.html</code></span>',
    );
    expect(html).toContain(
      'href="/api/sessions/os-assets-test/assets/raw/report.html"',
    );
  });

  it("resolves an unambiguous trailing filename to its nested asset", () => {
    const html = renderMarkdown("Compare before.png with the result.", assets);
    expect(html).toContain('data-asset-path="shots/before.png"');
    expect(html).toContain(
      '<span class="asset-ref-label">before.png</span></a>',
    );
  });

  it("leaves unknown and ambiguous names as plain text", () => {
    const ambiguous = {
      sessionId: "os-assets-test",
      assetPaths: ["first/index.html", "second/index.html"],
    };
    expect(renderMarkdown("Open summary.html.", assets)).not.toContain(
      "asset-ref",
    );
    expect(renderMarkdown("Open index.html.", ambiguous)).not.toContain(
      "asset-ref",
    );
    expect(renderMarkdown("Open first/index.html.", ambiguous)).toContain(
      'data-asset-path="first/index.html"',
    );
  });

  it("keeps an explicit markdown link as the destination", () => {
    const html = renderMarkdown(
      "Read [`report.html`](https://example.com/report.html).",
      assets,
    );
    expect(html).toContain('href="https://example.com/report.html"');
    expect(html).toContain("<code>report.html</code>");
    expect(html).not.toContain("asset-ref");
  });

  it("chips an explicit link that points at one of the session's assets", () => {
    const html = renderMarkdown(
      "Open the [interactive preview](shadow-preview.html).",
      { sessionId: "os-assets-test", assetPaths: ["shadow-preview.html"] },
    );
    expect(html).toContain('class="asset-ref"');
    expect(html).toContain('data-asset-path="shadow-preview.html"');
    expect(html).toContain(
      '<span class="asset-ref-label">interactive preview</span>',
    );
    expect(html).toContain(
      'href="/api/sessions/os-assets-test/assets/raw/shadow-preview.html"',
    );
  });

  it("chips a link written as the asset's own raw URL", () => {
    const html = renderMarkdown(
      "See [before.png](/api/sessions/os-assets-test/assets/raw/shots/before.png).",
      assets,
    );
    expect(html).toContain('data-asset-path="shots/before.png"');
  });

  it("leaves a link to another session's asset alone", () => {
    const html = renderMarkdown(
      "See [x](/api/sessions/os-other/assets/raw/report.html).",
      assets,
    );
    expect(html).not.toContain("asset-ref");
  });

  it("leaves a relative link that names no asset alone", () => {
    const html = renderMarkdown("See [docs](docs/setup.md).", assets);
    expect(html).not.toContain("asset-ref");
    expect(html).toContain('href="docs/setup.md"');
  });

  it("does not link a matching filename inside a larger path or address", () => {
    const html = renderMarkdown(
      "See https://example.com/report.html or mail@report.html.",
      assets,
    );
    expect(html).not.toContain("asset-ref");
  });

  it("does not treat an @-prefixed unknown name as an asset", () => {
    expect(
      renderMarkdown("Ask @report.html for details.", assets),
    ).not.toContain("asset-ref");
  });

  it("keeps exact asset names linkable past the former alias cap", () => {
    const paths = Array.from(
      { length: 601 },
      (_, index) => `asset-${String(index).padStart(4, "0")}.txt`,
    );
    const html = renderMarkdown("Open asset-0600.txt.", {
      sessionId: "os-many-assets",
      assetPaths: paths,
    });
    expect(html).toContain('data-asset-path="asset-0600.txt"');
  });

  it("does not reuse cached plain markdown once asset context is available", () => {
    const source = "Open report.html.";
    expect(renderMarkdown(source)).not.toContain("asset-ref");
    expect(renderMarkdown(source, assets)).toContain(
      'data-asset-path="report.html"',
    );
  });
});

describe("renderMarkdown PR mentions", () => {
  const fusion = { repo: "tella-fusion" };

  it("links a bare #number to the review page for the rendering repo", () => {
    const html = renderMarkdown("Fixed in #5528, ready to merge.", fusion);
    expect(html).toContain('class="pr-ref"');
    expect(html).toContain('href="/pr/tella-fusion/5528"');
    expect(html).toContain('data-pr-repo="tella-fusion"');
    expect(html).toContain('data-pr-number="5528"');
    expect(html).toContain('class="pr-ref-icon" aria-hidden="true"');
    expect(html).toContain('<span class="pr-ref-label">#5528</span>');
  });

  it("carries the GitHub name for the cmd-click escape, when known", () => {
    setKnownRepos([{ id: "tella-fusion", ghRepo: "tellahq/tella-fusion" }]);
    expect(renderMarkdown("Fixed in #5528.", fusion)).toContain(
      'data-pr-gh="tellahq/tella-fusion"',
    );
    // A repo with no GitHub name still links here; there is just nowhere to
    // escape to, so the chip carries no target.
    setKnownRepos([{ id: "tella-fusion" }]);
    const local = renderMarkdown("Fixed in #5528.", fusion);
    expect(local).toContain('href="/pr/tella-fusion/5528"');
    expect(local).not.toContain("data-pr-gh");
  });

  it("shows live open, draft, merged, and closed state", () => {
    for (const [state, isDraft, label, tone] of [
      ["OPEN", false, "Open", "green"],
      ["OPEN", true, "Draft", "muted"],
      ["MERGED", false, "Merged", "purple"],
      ["CLOSED", false, "Closed", "muted"],
    ] as const) {
      setKnownPrStates([
        { repo: "tella-fusion", number: 5528, state, isDraft },
      ]);
      const html = renderMarkdown("Fixed in #5528.", fusion);
      expect(html).toContain(`data-pr-tone="${tone}"`);
      expect(html).toContain(`· ${label}`);
      expect(html).not.toContain("pr-ref-state");
    }
  });

  it("uses mergeability, reviews, and checks to color the whole chip", () => {
    for (const [input, label, state, tone] of [
      [
        { state: "OPEN", mergeable: "MERGEABLE" },
        "Mergeable",
        "mergeable",
        "green",
      ],
      [
        { state: "OPEN", reviewDecision: "APPROVED" },
        "Approved",
        "approved",
        "green",
      ],
      [
        { state: "OPEN", mergeable: "CONFLICTING" },
        "Conflicts",
        "conflicts",
        "red",
      ],
      [
        { state: "OPEN", checks: { failed: 1 } },
        "Checks failing",
        "checks-failing",
        "red",
      ],
      [
        { state: "OPEN", checks: { pending: 2 } },
        "Checks running",
        "checks-running",
        "yellow",
      ],
    ] as const) {
      setKnownPrStates([{ repo: "tella-fusion", number: 5528, ...input }]);
      const html = renderMarkdown("Fixed in #5528.", fusion);
      expect(html).toContain(`data-pr-state="${state}"`);
      expect(html).toContain(`data-pr-tone="${tone}"`);
      expect(html).toContain(`· ${label}`);
      expect(html).not.toContain("pr-ref-state");
    }
  });

  it("shows open state for a PR no loaded session owns", () => {
    setKnownRepoPrStates([
      {
        repo: "tella-fusion",
        number: 5528,
        state: "OPEN",
        checks: { failed: 0, pending: 0 },
      },
    ]);
    const html = renderMarkdown("Fixed in #5528.", fusion);
    expect(html).toContain('data-pr-state="open"');
    expect(html).toContain('data-pr-tone="green"');
  });

  it("repairs a bare cross-repo number when exactly one known PR matches", () => {
    setKnownRepos([
      { id: "opensession", ghRepo: "tellahq/opensession" },
      { id: "tella-fusion", ghRepo: "tellahq/tella-fusion" },
    ]);
    setKnownRepoPrStates([
      {
        repo: "tella-fusion",
        number: 5596,
        state: "OPEN",
        mergeable: "CONFLICTING",
      },
    ]);
    const html = renderMarkdown("PR #5596 has conflicts.", {
      repo: "opensession",
    });
    expect(html).toContain('href="/pr/tella-fusion/5596"');
    expect(html).toContain('data-pr-repo="tella-fusion"');
    expect(html).toContain('data-pr-context-repo="opensession"');
    expect(html).toContain('data-pr-state="conflicts"');
  });

  it("does not guess a cross-repo number when several known PRs match", () => {
    setKnownRepoPrStates([
      { repo: "tella-fusion", number: 5596, state: "OPEN" },
      { repo: "tella-web", number: 5596, state: "MERGED" },
    ]);
    const html = renderMarkdown("PR #5596 changed.", { repo: "opensession" });
    expect(html).toContain('href="/pr/opensession/5596"');
    expect(html).toContain('data-pr-repo="opensession"');
    expect(html).not.toContain("data-pr-tone");
  });

  it("never rewrites an explicitly qualified PR", () => {
    setKnownRepos([
      { id: "opensession", ghRepo: "tellahq/opensession" },
      { id: "tella-fusion", ghRepo: "tellahq/tella-fusion" },
    ]);
    setKnownRepoPrStates([
      { repo: "tella-fusion", number: 5596, state: "OPEN" },
    ]);
    const html = renderMarkdown("opensession#5596 changed.", {
      repo: "opensession",
    });
    expect(html).toContain('href="/pr/opensession/5596"');
    expect(html).not.toContain("data-pr-context-repo");
  });

  it("prefers richer session state over the repo-wide open list", () => {
    setKnownRepoPrStates([
      { repo: "tella-fusion", number: 5528, state: "OPEN" },
    ]);
    setKnownPrStates([{ repo: "tella-fusion", number: 5528, state: "MERGED" }]);
    const html = renderMarkdown("Fixed in #5528.", fusion);
    expect(html).toContain('data-pr-state="merged"');
    expect(html).toContain('data-pr-tone="purple"');
  });

  it("does not let stale session state resurrect an archived PR", () => {
    setKnownPrStates([{ repo: "tella-fusion", number: 5528, state: "OPEN" }]);
    setKnownRepoPrStates([
      { repo: "tella-fusion", number: 5528, state: "MERGED" },
    ]);
    const html = renderMarkdown("Fixed in #5528.", fusion);
    expect(html).toContain('data-pr-state="merged"');
    expect(html).toContain('data-pr-tone="purple"');
  });

  it("drops stale state when the PR cache no longer contains the reference", () => {
    setKnownPrStates([{ repo: "tella-fusion", number: 5528, state: "OPEN" }]);
    expect(renderMarkdown("Fixed in #5528.", fusion)).toContain(
      'data-pr-state="open"',
    );
    setKnownPrStates([]);
    expect(renderMarkdown("Fixed in #5528.", fusion)).not.toContain(
      "data-pr-tone",
    );
  });

  it("keeps the newest state when several sessions reference the same PR", () => {
    setKnownPrStates([
      { repo: "tella-fusion", number: 5528, state: "MERGED" },
      { repo: "tella-fusion", number: 5528, state: "OPEN" },
    ]);
    const html = renderMarkdown("Fixed in #5528.", fusion);
    expect(html).toContain('data-pr-state="merged"');
    expect(html).toContain("· Merged");
  });

  it("leaves a mention plain when the caller renders without a repo", () => {
    const html = renderMarkdown("Fixed in #5528, ready to merge.");
    expect(html).not.toContain("pr-ref");
    expect(html).toContain("#5528");
  });

  it("places a qualified mention by its own repo, registered ones only", () => {
    setKnownRepos([
      { id: "tella-fusion", ghRepo: "tellahq/tella-fusion" },
      { id: "opensession", ghRepo: "tellahq/opensession" },
    ]);
    const qualified = renderMarkdown("See opensession#128 and #5528.", fusion);
    expect(qualified).toContain('href="/pr/opensession/128"');
    expect(qualified).toContain(
      '<span class="pr-ref-label">opensession#128</span>',
    );
    // the bare one still belongs to the rendering repo
    expect(qualified).toContain('href="/pr/tella-fusion/5528"');
    // owner/repo is the same repo, addressed the GitHub way
    expect(renderMarkdown("tellahq/opensession#128", fusion)).toContain(
      'href="/pr/opensession/128"',
    );
    // a name this instance doesn't serve stays text — the route can't resolve it
    const unknown = renderMarkdown("vercel/next.js#1234 is upstream.", fusion);
    expect(unknown).not.toContain("pr-ref");
  });

  it("does not fire on the things that merely look like a PR mention", () => {
    setKnownRepos([{ id: "tella-fusion", ghRepo: "tellahq/tella-fusion" }]);
    for (const src of [
      "the colour is #123456 in both themes", // 6+ digits: never a mention
      "em dash entity &#8212; here",
      "issue ##12 double hash",
      "`#5528` stays a code chip",
      "    #5528 in an indented code block",
      "# 5528 is a heading",
    ]) {
      expect(renderMarkdown(src, fusion)).not.toContain("pr-ref");
    }
  });

  it("keeps a short number that only has its digits to go on as prose", () => {
    setKnownRepos([{ id: "backstage", ghRepo: "tellahq/backstage" }]);
    const backstage = { repo: "backstage" };
    for (const src of [
      "step #3 is the tricky one",
      "take #2 of the recording",
      "stream #0 carries the audio",
      "the border reads #333 in both themes",
      "that page ranks #29 for the term",
    ]) {
      expect(renderMarkdown(src, backstage)).not.toContain("pr-ref");
    }
  });

  it("links a short number the text vouches for, however small", () => {
    setKnownRepos([{ id: "backstage", ghRepo: "tellahq/backstage" }]);
    const backstage = { repo: "backstage" };
    // The word in front of it. The chip stays `#92` — the cue is prose, and
    // the chip already carries a PR icon.
    const cued = renderMarkdown("Landed in PR #92 last night.", backstage);
    expect(cued).toContain('href="/pr/backstage/92"');
    expect(cued).toContain("PR <a");
    expect(cued).toContain('<span class="pr-ref-label">#92</span>');
    for (const src of ["see PRs #92 and #14", "pr #92", "PR#92"]) {
      expect(renderMarkdown(src, backstage)).toContain('data-pr-number="92"');
    }
    // A qualifier says the same thing, and is the only form that crosses repos.
    expect(renderMarkdown("follows backstage#92 closely", fusion)).toContain(
      'href="/pr/backstage/92"',
    );
    // So does a PR the session list already knows for this repo.
    setKnownPrStates([{ repo: "backstage", number: 92, state: "OPEN" }]);
    expect(renderMarkdown("follows #92 closely", backstage)).toContain(
      'href="/pr/backstage/92"',
    );
  });

  it("does not read a repo id starting with `pr` as the cue", () => {
    setKnownRepos([
      { id: "prisma", ghRepo: "tellahq/prisma" },
      { id: "tella-fusion", ghRepo: "tellahq/tella-fusion" },
    ]);
    // `pr` + `isma` would be a cue plus an unknown qualifier; it is one repo.
    expect(renderMarkdown("prisma#12 is green", fusion)).toContain(
      'href="/pr/prisma/12"',
    );
    // And an unregistered repo stays text rather than borrowing the cue path.
    expect(renderMarkdown("press#12 is upstream", fusion)).not.toContain(
      "pr-ref",
    );
  });

  it("reads mentions as they are actually written in prose", () => {
    // Sentence-final, parenthesised, inside emphasis, at the start of a line,
    // and in a list — all the same reference.
    for (const src of [
      "Shipped in #5528.",
      "Shipped (#5528) yesterday",
      "**#5528** is the one",
      "#5528 is the one",
      "- reverts #5528\n- keeps #42",
    ]) {
      expect(renderMarkdown(src, fusion)).toContain('data-pr-number="');
    }
  });

  it("leaves a URL fragment alone", () => {
    setKnownRepos([{ id: "tella-fusion", ghRepo: "tellahq/tella-fusion" }]);
    const html = renderMarkdown(
      "https://github.com/tellahq/tella-fusion/pull/5528#issuecomment-12345",
      fusion,
    );
    expect(html).not.toContain("pr-ref");
  });

  it("turns an explicit GitHub PR link into the same in-app chip", () => {
    setKnownRepos([{ id: "tella-fusion", ghRepo: "tellahq/tella-fusion" }]);
    const html = renderMarkdown(
      "[PR #5528](https://github.com/tellahq/tella-fusion/pull/5528)",
      fusion,
    );
    expect(html).toContain('class="pr-ref"');
    expect(html).toContain('href="/pr/tella-fusion/5528"');
    expect(html).toContain('data-pr-gh="tellahq/tella-fusion"');
    expect(html).toContain('<span class="pr-ref-label">PR #5528</span>');
  });

  it("labels a pasted GitHub PR URL without showing the whole URL", () => {
    setKnownRepos([{ id: "tella-fusion", ghRepo: "tellahq/tella-fusion" }]);
    const url = "https://github.com/tellahq/tella-fusion/pull/5528";
    const html = renderMarkdown(`Open ${url}.`, fusion);
    expect(html).toContain('href="/pr/tella-fusion/5528"');
    expect(html).toContain('<span class="pr-ref-label">PR #5528</span>');
    expect(html).not.toContain(`>${url}</a>`);
  });

  it("collapses a qualified mention and its own pasted URL to one chip", () => {
    setKnownRepos([{ id: "tella-fusion", ghRepo: "tellahq/tella-fusion" }]);
    const sources = [
      "## PR **tella-fusion#5832** — https://github.com/tellahq/tella-fusion/pull/5832",
      "tella-fusion#5832 https://github.com/tellahq/tella-fusion/pull/5832",
      "tella-fusion#5832 (https://github.com/tellahq/tella-fusion/pull/5832)",
      "PR #5832: https://github.com/tellahq/tella-fusion/pull/5832",
    ];
    for (const src of sources) {
      const html = renderMarkdown(src, fusion);
      expect(html.match(/class="pr-ref"/g)?.length).toBe(1);
      expect(html).toContain('data-pr-number="5832"');
      expect(html).not.toContain("github.com/tellahq/tella-fusion/pull");
    }
  });

  it("keeps two different pull requests as two chips", () => {
    setKnownRepos([{ id: "tella-fusion", ghRepo: "tellahq/tella-fusion" }]);
    const html = renderMarkdown(
      "tella-fusion#5832 — https://github.com/tellahq/tella-fusion/pull/5528",
      fusion,
    );
    expect(html.match(/class="pr-ref"/g)?.length).toBe(2);
  });

  it("leaves a mention alone when the URL is a different repo", () => {
    setKnownRepos([{ id: "tella-fusion", ghRepo: "tellahq/tella-fusion" }]);
    const html = renderMarkdown(
      "tella-fusion#5832 — https://github.com/vercel/next.js/pull/5832",
      fusion,
    );
    expect(html.match(/class="pr-ref"/g)?.length).toBe(1);
    expect(html).toContain("vercel/next.js/pull/5832");
  });

  it("leaves a code-span mention and its URL alone", () => {
    setKnownRepos([{ id: "tella-fusion", ghRepo: "tellahq/tella-fusion" }]);
    const html = renderMarkdown(
      "`tella-fusion#5832`: https://github.com/tellahq/tella-fusion/pull/5832",
      fusion,
    );
    // The code span never chips, so the URL is the only reference that can
    // open anything and has to survive.
    expect(html).toContain("<code>tella-fusion#5832</code>");
    expect(html.match(/class="pr-ref"/g)?.length).toBe(1);
  });

  it("leaves a duplicate inside a code fence verbatim", () => {
    setKnownRepos([{ id: "tella-fusion", ghRepo: "tellahq/tella-fusion" }]);
    const html = renderMarkdown(
      "```\ntella-fusion#5832 — https://github.com/tellahq/tella-fusion/pull/5832\n```",
      fusion,
    );
    expect(html).toContain("github.com/tellahq/tella-fusion/pull/5832");
  });

  it("keeps links to unregistered GitHub PRs external", () => {
    setKnownRepos([{ id: "tella-fusion", ghRepo: "tellahq/tella-fusion" }]);
    const html = renderMarkdown(
      "[upstream PR](https://github.com/vercel/next.js/pull/1234)",
      fusion,
    );
    expect(html).not.toContain("pr-ref");
    expect(html).toContain('target="_blank"');
  });

  it("renders the same source differently per repo (cache is repo-keyed)", () => {
    const src = "Landed #4242.";
    expect(renderMarkdown(src, { repo: "tella-fusion" })).toContain(
      'href="/pr/tella-fusion/4242"',
    );
    expect(renderMarkdown(src, { repo: "opensession" })).toContain(
      'href="/pr/opensession/4242"',
    );
  });
});

describe("renderMarkdown commit references", () => {
  const os = { repo: "opensession" };
  const withGithub = () =>
    setKnownRepos([{ id: "opensession", ghRepo: "tellahq/opensession" }]);

  it("turns a sha codespan into a hoverable reference", () => {
    withGithub();
    const html = renderMarkdown(
      "This is reverting `4ed1ef09` + `437cba77`.",
      os,
    );
    expect(html).toContain('class="commit-ref"');
    expect(html).toContain('data-commit-sha="4ed1ef09"');
    expect(html).toContain('data-commit-sha="437cba77"');
    expect(html).toContain('data-commit-repo="opensession"');
    expect(html).toContain(
      'href="https://github.com/tellahq/opensession/commit/4ed1ef09"',
    );
    expect(html).toContain(">4ed1ef09</a>");
    // Not a chip: the sha keeps the shape it was written in.
    expect(html).not.toContain("commit-ref-icon");
  });

  it("reads a full sha and an upper-case one", () => {
    withGithub();
    const full = "a".repeat(39) + "1";
    expect(renderMarkdown(`Pinned at \`${full}\`.`, os)).toContain(
      `data-commit-sha="${full}"`,
    );
    expect(renderMarkdown("Pinned at `4ED1EF09`.", os)).toContain(
      'data-commit-sha="4ed1ef09"',
    );
  });

  it("links a bare sha a cue word vouches for, keeping the cue as prose", () => {
    withGithub();
    const html = renderMarkdown("Fixed in commit 4ed1ef09 last night.", os);
    expect(html).toContain("commit <a");
    expect(html).toContain('data-commit-sha="4ed1ef09"');
    for (const src of ["commits 4ed1ef09 and 437cba77", "sha 4ed1ef09"]) {
      expect(renderMarkdown(src, os)).toContain('data-commit-sha="4ed1ef09"');
    }
  });

  it("leaves bare hex in prose alone", () => {
    withGithub();
    // Measured at 18% real commits, against 98% for the codespan form: prose
    // is full of ids, hashes and timestamps that are hex by accident.
    const html = renderMarkdown("The id 4ed1ef09 came back from the API.", os);
    expect(html).not.toContain("commit-ref");
    expect(html).toContain("4ed1ef09");
    expect(renderMarkdown("precommit 4ed1ef09 hook", os)).not.toContain(
      "commit-ref",
    );
  });

  it("does not fire on the things that merely look like a sha", () => {
    withGithub();
    for (const src of [
      "`1786042878` is epoch milliseconds", // all digits: a number, not a sha
      "`3625732127` names the CI run",
      "`f6f8fa` is the code well fill", // 6 hex: a colour
      "`120a8d94363c2d90b7b92710f58cf9ce` is an md5", // 32 hex: never a commit
      "`b43e9281b96037e3` is a 16-hex id",
      "`4ed1ef09g` is not hex at all",
    ]) {
      const html = renderMarkdown(src, os);
      expect(html).not.toContain("commit-ref");
      // and it still renders as the code it was written as
      expect(html).toContain("<code>");
    }
  });

  it("stays plain when the caller renders without a repo", () => {
    withGithub();
    const html = renderMarkdown("This is reverting `4ed1ef09`.");
    expect(html).not.toContain("commit-ref");
    expect(html).toContain("<code>4ed1ef09</code>");
  });

  it("is a focusable term, not a dead link, without a GitHub name", () => {
    setKnownRepos([{ id: "opensession" }]);
    const html = renderMarkdown("Reverting `4ed1ef09`.", os);
    expect(html).toContain('<span class="commit-ref"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain("href=");
  });

  it("turns a pasted GitHub commit URL into the same reference", () => {
    withGithub();
    const url =
      "https://github.com/tellahq/opensession/commit/4ed1ef09aa11bb22cc33dd44ee55ff6600778899";
    const html = renderMarkdown(url, os);
    expect(html).toContain('class="commit-ref"');
    expect(html).toContain(">4ed1ef09</a>");
    // A labelled link is the author's prose and keeps its words.
    const labelled = renderMarkdown(`[the revert](${url})`, os);
    expect(labelled).not.toContain("commit-ref");
    expect(labelled).toContain("the revert");
    // Another org's commit is not ours to resolve.
    expect(
      renderMarkdown("https://github.com/vercel/next.js/commit/4ed1ef09", os),
    ).not.toContain("commit-ref");
  });

  it("degrades inside an explicit link instead of nesting anchors", () => {
    withGithub();
    const html = renderMarkdown("[see `4ed1ef09`](https://example.com/x)", os);
    expect(html).not.toContain("commit-ref");
    expect(html).toContain("<code>4ed1ef09</code>");
    expect(html).toContain('href="https://example.com/x"');
    // The same guard covers the chips the codespan renderer makes.
    const session = renderMarkdown(
      "[the worker](https://example.com/x) and `bks-019f24b5-f31d-7000-a48f-31a9e829c4ae`",
      os,
    );
    expect(session).toContain("session-link");
    expect(
      renderMarkdown(
        "[worker `bks-019f24b5-f31d-7000-a48f-31a9e829c4ae`](https://example.com/x)",
        os,
      ),
    ).not.toContain("session-link");
  });
});

describe("renderMarkdown strikethrough (double-tilde only)", () => {
  it("does not strike through single tildes in code-ish content", () => {
    // ReScript labeled args, approximate numbers, home paths — all bare tildes.
    for (const src of [
      "updateUpdatedAt(~storyID=query.id, ~sceneID=scene.id)",
      "call foo(~storyID) then bar(~sceneID) next",
      "That leaves ~352 across ~165 files",
      "edit ~/.config and ~/.bashrc",
    ]) {
      expect(renderMarkdown(src)).not.toContain("<del>");
    }
  });

  it("still renders real ~~strikethrough~~", () => {
    expect(renderMarkdown("this is ~~struck~~ text")).toContain(
      "<del>struck</del>",
    );
  });
});

describe("renderPrCommentMarkdown GitHub details", () => {
  it("renders collapsible reviews and subtext", () => {
    const html =
      renderPrCommentMarkdown(`<details> <summary>Outdated review</summary>
**Ada review** · request changes

<sub>Reviewed 3147253 · open session</sub>
</details>`);

    expect(html).toContain('<details class="md-details">');
    expect(html).toContain("<summary>Outdated review</summary>");
    expect(html).toContain("<strong>Ada review</strong>");
    expect(html).toContain("<sub>Reviewed 3147253 · open session</sub>");
  });

  it("continues to escape untrusted HTML", () => {
    const html = renderPrCommentMarkdown(
      "<details><summary>Safe</summary><script>alert(1)</script></details>",
    );
    expect(html).toContain('<details class="md-details">');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("still builds the card when the tags carry attributes", () => {
    const html = renderPrCommentMarkdown(
      '<details open><summary class="x">Logs</summary>\n\nfirst\n\nsecond\n</details>',
    );
    expect(html).toContain('<details class="md-details" open>');
    expect(html).toContain("<summary>Logs</summary>");
    expect(html).toContain('<div class="md-details-body">');
    expect(html).toContain("<p>first</p>");
    // One card, not a summary followed by loose paragraphs.
    expect(html.match(/<details/g)?.length).toBe(1);
  });

  it("gives a nested details its own card", () => {
    const html = renderPrCommentMarkdown(
      "<details><summary>Outer</summary>\n\nbefore\n\n<details><summary>Inner</summary>\n\ninside\n</details>\n</details>",
    );
    expect(html.match(/<details class="md-details">/g)?.length).toBe(2);
    expect(html).toContain("<summary>Inner</summary>");
    // Balanced: every card closes.
    expect(html.match(/<details/g)?.length).toBe(
      html.match(/<\/details>/g)?.length,
    );
  });

  it("keeps a placeholder-looking comment intact", () => {
    const html = renderPrCommentMarkdown(
      "OPENSESSIONDETAILSTOKEN0END\n\n<details><summary>S</summary>\n\nbody\n</details>",
    );
    expect(html).toContain("OPENSESSIONDETAILSTOKEN0END");
    expect(html).toContain("<summary>S</summary>");
    expect(html).toContain("<p>body</p>");
  });

  it("drops the attributes a tag is not allowed to keep", () => {
    const html = renderPrCommentMarkdown(
      '<details open onclick="alert(1)"><summary>Unsafe</summary>Body</details>',
    );
    expect(html).toContain('<details class="md-details" open>');
    expect(html).not.toContain("onclick");
  });
});

describe("renderPrCommentMarkdown bot markup", () => {
  // Vercel writes the project avatar as raw HTML inside a markdown table cell,
  // which markdown has no syntax for.
  const row =
    '| <a href="https://vercel.com/tella/internal"><sup><img src="https://vercel.com/api/www/avatar?projectId=prj_x&teamId=team_y&s=32" width="16" height="16" align="middle" alt="" /></sup></a> [internal](https://vercel.com/tella/internal) | Ready |';
  const table = `| Project | Deployment |\n| :--- | :--- |\n${row}`;

  it("renders the avatar link instead of showing its tags", () => {
    const html = renderPrCommentMarkdown(table);
    expect(html).toContain('<sup><img src="https://vercel.com/api/www/avatar');
    expect(html).toContain('<a href="https://vercel.com/tella/internal"');
    expect(html).not.toContain("&lt;a href");
    expect(html).not.toContain("&lt;sup&gt;");
  });

  it("renders Vercel's relative timestamp instead of showing its tags", () => {
    const html = renderPrCommentMarkdown(
      '| Updated |\n| :--- |\n| <relative-time datetime="2026-09-01T09:52:50.595Z">Sep 1, 2026 9:52am UTC</relative-time> |',
    );
    expect(html).toContain(
      '<relative-time datetime="2026-09-01T09:52:50.595Z">Sep 1, 2026 9:52am UTC</relative-time>',
    );
    expect(html).not.toContain("&lt;relative-time");
  });

  it("opens a hand-written link in a new tab", () => {
    expect(renderPrCommentMarkdown(table)).toContain(
      '<a href="https://vercel.com/tella/internal" target="_blank" rel="noopener noreferrer">',
    );
  });

  it("leaves session markdown escaping alone", () => {
    // The sanitizer is asked for per call, so a transcript rendered right
    // after a PR comment still escapes its raw HTML.
    renderPrCommentMarkdown("<kbd>K</kbd>");
    expect(renderMarkdown("<kbd>K</kbd>")).toContain("&lt;kbd&gt;");
  });
});

describe("renderMarkdown @-mentions", () => {
  // The roster is module state, so publish it once for this block. The
  // renderer's cache is keyed on the source text, and setKnownPeople clears
  // it, so this cannot leak a stale render into the assertions below.
  beforeAll(() => {
    setKnownPeople([
      { name: "Kent", github: "kentdebruin" },
      { name: "Nolan" },
    ]);
  });

  const persons = (html: string) =>
    [...html.matchAll(/data-person="([^"]+)"/g)].map((m) => m[1]);

  it("renders a roster name as that person's chip", () => {
    const html = renderMarkdown("@Kent can you look?");
    expect(persons(html)).toEqual(["Kent"]);
    expect(html).toContain("https://github.com/kentdebruin.png");
  });

  it("falls back to an initial for somebody with no GitHub login", () => {
    const html = renderMarkdown("@Nolan too");
    expect(persons(html)).toEqual(["Nolan"]);
    expect(html).toContain("person-chip-initial");
    expect(html).not.toContain('<img class="person-chip-face"');
  });

  it("matches case-insensitively and reports the roster spelling", () => {
    expect(persons(renderMarkdown("@kent"))).toEqual(["Kent"]);
  });

  it("leaves trailing punctuation in the sentence", () => {
    const html = renderMarkdown("ping @Kent, please");
    expect(persons(html)).toEqual(["Kent"]);
    expect(html).toContain(", please");
  });

  it("does not fire on the things that merely look like a mention", () => {
    // An email address, another service's handle, quoted CSS, a name nobody
    // has. Turning any of these into a person invents a teammate.
    for (const src of [
      "mail me@example.com",
      "@media (hover: hover)",
      "@nobody here",
      "`@Kent` in code",
    ])
      expect(persons(renderMarkdown(src))).toEqual([]);
  });

  it("still links an email while chipping a real mention beside it", () => {
    const html = renderMarkdown("mail alex@example.com and tag @Kent");
    expect(persons(html)).toEqual(["Kent"]);
    expect(html).toContain('href="mailto:alex@example.com"');
  });

  it("mentions nobody once the roster is empty", () => {
    setKnownPeople([]);
    expect(persons(renderMarkdown("@Kent"))).toEqual([]);
  });
});

describe("GitHub user-attachment media", () => {
  const id = "d087b2cd-9724-4d3d-8b0e-8c25700395e1";
  const url = `https://github.com/user-attachments/assets/${id}`;
  const proxied = `/gh-asset/${id}?repo=opensession`;

  it("proxies image syntax through /gh-asset", () => {
    const html = renderPrCommentMarkdown(`![shot](${url})`, {
      repo: "opensession",
    });
    expect(html).toContain(`<img class="md-image" src="${proxied}"`);
    expect(html).toContain(`<a href="${proxied}"`);
  });

  it("renders a bare attachment URL as an inline video on PR surfaces", () => {
    const html = renderPrCommentMarkdown(url, { repo: "opensession" });
    expect(html).toContain(`<video class="md-video" src="${proxied}"`);
  });

  it("keeps a labelled link a link, pointed at the proxy", () => {
    const html = renderPrCommentMarkdown(`[demo](${url})`, {
      repo: "opensession",
    });
    expect(html).toContain(`<a href="${proxied}"`);
    expect(html).toContain(">demo</a>");
    expect(html).not.toContain("<video");
  });

  it("rewrites an expired signed URL onto the same proxy", () => {
    const signed = `https://private-user-images.githubusercontent.com/213769834/636480332-${id}.png?jwt=eyJ0`;
    const html = renderPrCommentMarkdown(`![shot](${signed})`, {
      repo: "opensession",
    });
    expect(html).toContain(`src="${proxied}"`);
  });

  it("leaves the URL alone without a repo to authorize through", () => {
    const html = renderPrCommentMarkdown(`![shot](${url})`);
    expect(html).toContain(`src="${url}"`);
  });

  it("links rather than video-ifies a bare attachment URL in transcript prose", () => {
    const html = renderMarkdown(url, { repo: "opensession" });
    expect(html).not.toContain("<video");
    expect(html).toContain(`<a href="${proxied}"`);
  });
});
