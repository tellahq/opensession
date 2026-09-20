import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

// Execute the actual pre-paint bootstrap with a controllable WebKit window.
// Chromium phone emulation cannot reproduce iOS standalone letterboxing.
const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
const bootstrap = html.slice(
  html.indexOf("var iphoneStandalone ="),
  html.indexOf("// The Electron shell owns"),
);

function viewportHarness(standalone = true) {
  let now = 0;
  let nextTimer = 0;
  let keyboard = false;
  let writes = 0;
  const scrolls: Array<[number, number]> = [];
  const viewportEvents = new EventTarget();
  const initialFocus: { tagName: string; isContentEditable?: boolean } | null =
    { tagName: "BODY" };
  const timers = new Map<number, { at: number; callback: () => void }>();
  const windowEvents = new EventTarget();
  const documentEvents = new EventTarget();
  const document = {
    hidden: false,
    activeElement: initialFocus,
    documentElement: {
      style: {
        value: "",
        get height() {
          return this.value;
        },
        set height(value: string) {
          writes++;
          this.value = value;
        },
      },
    },
    body: {
      style: { height: "" },
      classList: { contains: () => keyboard },
    },
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
  };
  const viewport = {
    offsetTop: 0,
    scale: 1,
    addEventListener: viewportEvents.addEventListener.bind(viewportEvents),
  };
  const window = {
    screen: { height: 844 },
    innerHeight: 784,
    scrollY: 0,
    visualViewport: viewport,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    scrollTo(x: number, y: number) {
      scrolls.push([x, y]);
      viewport.offsetTop = y;
      window.scrollY = y;
    },
  };
  runInNewContext(bootstrap, {
    window,
    document,
    navigator: { userAgent: "iPhone", standalone },
    matchMedia: () => ({ matches: standalone }),
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextTimer;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  });
  return {
    window,
    document,
    viewport,
    scrolls,
    get writes() {
      return writes;
    },
    fireViewport(name: string) {
      viewportEvents.dispatchEvent(new Event(name));
    },
    keyboard(open: boolean) {
      keyboard = open;
    },
    fireWindow(name: string) {
      windowEvents.dispatchEvent(new Event(name));
    },
    fireDocument(name: string) {
      documentEvents.dispatchEvent(new Event(name));
    },
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
    expectHeight(height: string) {
      expect(document.documentElement.style.height).toBe(height);
      expect(document.body.style.height).toBe(height);
    },
  };
}

describe("standalone viewport recovery", () => {
  test("failed correction stays bounded but retries on foreground without a reload", () => {
    const app = viewportHarness();
    app.expectHeight("844px");
    app.advance(300);
    app.expectHeight("");
    const writes = app.writes;
    app.fireWindow("resize");
    app.advance(1000);
    expect(app.writes).toBe(writes);

    app.document.hidden = true;
    app.fireDocument("visibilitychange");
    app.document.hidden = false;
    app.fireDocument("visibilitychange");
    app.expectHeight("844px");
    app.advance(450);
    app.window.innerHeight = 844;
    app.advance(550);
    app.expectHeight("844px");
  });

  test("a persistently short window still releases the override after resume", () => {
    const app = viewportHarness();
    app.advance(300);
    app.fireWindow("pageshow");
    app.advance(1000);
    app.expectHeight("");
    const writes = app.writes;
    app.advance(10_000);
    expect(app.writes).toBe(writes);
  });

  test("background geometry cannot reject an accepted full-height window", () => {
    const app = viewportHarness();
    app.window.innerHeight = 844;
    app.advance(300);
    app.fireWindow("resize");
    app.document.hidden = true;
    app.fireDocument("visibilitychange");
    app.window.innerHeight = 0;
    app.advance(1000);
    app.expectHeight("844px");
    app.fireWindow("resize");
    app.advance(300);
    app.expectHeight("844px");
  });

  test("keyboard dismissal retries after kb-open is cleared and the animation settles", () => {
    const app = viewportHarness();
    app.advance(300);
    app.keyboard(true);
    app.window.innerHeight = 500;
    app.fireWindow("pageshow");
    app.advance(1000);
    app.expectHeight("");
    app.fireDocument("focusout");
    app.expectHeight("");
    app.keyboard(false);
    app.advance(250);
    app.expectHeight("844px");
    app.window.innerHeight = 844;
    app.advance(750);
    app.expectHeight("844px");
  });

  test("moving between text fields does not force full-screen height over a keyboard", () => {
    const app = viewportHarness();
    app.advance(300);
    app.keyboard(true);
    app.fireDocument("focusout");
    app.advance(1000);
    app.expectHeight("");
  });

  test("rotation supersedes pending checks of the old screen height", () => {
    const app = viewportHarness();
    app.advance(200);
    app.window.screen.height = 390;
    app.window.innerHeight = 390;
    app.fireWindow("orientationchange");
    app.advance(1000);
    app.expectHeight("390px");
  });

  test("browser tabs never get the standalone correction", () => {
    const app = viewportHarness(false);
    app.fireWindow("pageshow");
    app.fireDocument("focusout");
    app.fireDocument("visibilitychange");
    app.advance(1000);
    app.expectHeight("");
    expect(app.writes).toBe(0);
  });
  test("a phantom visual viewport pan with nothing focused is released once it rests", () => {
    const app = viewportHarness();
    app.advance(1000);
    // The pan grows through a gesture: each move restarts the wait.
    for (const offset of [77, 138, 221, 300]) {
      app.viewport.offsetTop = offset;
      app.fireViewport("scroll");
      app.advance(100);
      expect(app.scrolls).toEqual([]);
    }
    app.advance(120);
    expect(app.scrolls).toEqual([[0, 0]]);
    expect(app.viewport.offsetTop).toBe(0);
    app.advance(5000);
    expect(app.scrolls).toEqual([[0, 0]]);
  });

  test("a keyboard pan keeps its focused field in view", () => {
    const app = viewportHarness();
    app.advance(1000);
    app.document.activeElement = { tagName: "TEXTAREA" };
    app.keyboard(true);
    app.viewport.offsetTop = 341;
    app.fireViewport("resize");
    app.fireViewport("scroll");
    app.advance(2000);
    expect(app.scrolls).toEqual([]);
    // Moving between fields: the class may briefly be off while an editable
    // element still has focus.
    app.keyboard(false);
    app.fireDocument("focusout");
    app.fireViewport("scroll");
    app.advance(2000);
    expect(app.scrolls).toEqual([]);
  });

  test("keyboard dismissal animates the pan back on its own", () => {
    const app = viewportHarness();
    app.advance(1000);
    app.document.activeElement = { tagName: "TEXTAREA" };
    app.keyboard(true);
    app.viewport.offsetTop = 341;
    app.fireViewport("scroll");
    app.advance(500);
    app.document.activeElement = { tagName: "BODY" };
    app.fireDocument("focusout");
    app.keyboard(false);
    for (const offset of [300, 180, 60, 0]) {
      app.viewport.offsetTop = offset;
      app.fireViewport("scroll");
      app.advance(16);
    }
    app.advance(2000);
    expect(app.scrolls).toEqual([]);
  });

  test("a pan left behind by a keyboard cycle is released after the animation", () => {
    const app = viewportHarness();
    app.advance(1000);
    app.document.activeElement = { tagName: "INPUT" };
    app.keyboard(true);
    app.viewport.offsetTop = 341;
    app.fireViewport("scroll");
    app.advance(500);
    app.document.activeElement = { tagName: "BODY" };
    app.fireDocument("focusout");
    app.keyboard(false);
    app.advance(500);
    expect(app.scrolls).toEqual([]);
    app.advance(200);
    expect(app.scrolls).toEqual([[0, 0]]);
  });

  test("resume checks for a stranded window scroll as well as a pan", () => {
    const app = viewportHarness();
    app.advance(1000);
    app.document.hidden = true;
    app.fireDocument("visibilitychange");
    app.window.scrollY = 62;
    app.document.hidden = false;
    app.fireDocument("visibilitychange");
    app.advance(700);
    expect(app.scrolls).toEqual([[0, 0]]);
    expect(app.window.scrollY).toBe(0);
  });

  test("a zoomed viewport is the reader's, not a phantom pan", () => {
    const app = viewportHarness();
    app.advance(1000);
    app.viewport.scale = 2;
    app.viewport.offsetTop = 200;
    app.fireViewport("scroll");
    app.advance(2000);
    expect(app.scrolls).toEqual([]);
  });

  test("a hidden page never scrolls its window", () => {
    const app = viewportHarness();
    app.advance(1000);
    app.document.hidden = true;
    app.viewport.offsetTop = 300;
    app.fireViewport("scroll");
    app.advance(2000);
    expect(app.scrolls).toEqual([]);
  });

  test("browser tabs never get the pan release either", () => {
    const app = viewportHarness(false);
    app.viewport.offsetTop = 300;
    app.fireViewport("scroll");
    app.fireWindow("scroll");
    app.advance(2000);
    expect(app.scrolls).toEqual([]);
  });
});
