const { describe, expect, test } = require("bun:test");
const { FRAME_AUDIO_SCRIPT } = require("./frame-audio");

// A framed page with just enough of the DOM and Web Audio for the reporter.
function fakePage() {
  const posted = [];
  const parent = { postMessage: (data) => posted.push(data.audible) };
  const page = new EventTarget();
  Object.assign(page, { parent });
  const document = new EventTarget();
  const attached = [];
  document.querySelectorAll = () => attached;

  class HTMLMediaElement extends EventTarget {
    paused = true;
    ended = false;
    muted = false;
    volume = 1;
    isConnected = false;
    play() {
      this.paused = false;
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    }
  }
  class AudioContext extends EventTarget {
    state = "running";
    suspend() {
      this.state = "suspended";
      this.dispatchEvent(new Event("statechange"));
      return Promise.resolve();
    }
  }
  class AudioScheduledSourceNode extends EventTarget {
    constructor(context) {
      super();
      this.context = context;
    }
    start() {}
    stop() {
      this.dispatchEvent(new Event("ended"));
    }
  }
  // Chrome gives buffer sources their own start, as here.
  class AudioBufferSourceNode extends AudioScheduledSourceNode {
    start() {}
  }
  page.HTMLMediaElement = HTMLMediaElement;
  page.AudioScheduledSourceNode = AudioScheduledSourceNode;
  page.AudioBufferSourceNode = AudioBufferSourceNode;
  const run = new Function(
    "window",
    "document",
    "location",
    "setInterval",
    FRAME_AUDIO_SCRIPT,
  );
  run(
    page,
    document,
    { ancestorOrigins: ["https://os.example.test"] },
    () => 0,
  );
  const pause = () => {
    const event = new MessageEvent("message", {
      data: { type: "opensession:pause-audio" },
      origin: "https://os.example.test",
    });
    Object.defineProperty(event, "source", { value: parent });
    page.dispatchEvent(event);
  };
  return {
    posted,
    AudioContext,
    AudioScheduledSourceNode,
    AudioBufferSourceNode,
    HTMLMediaElement,
    pause,
  };
}

describe("frame audio", () => {
  test("the reporter is a self-contained script", () => {
    expect(() => new Function(FRAME_AUDIO_SCRIPT)).not.toThrow();
    expect(FRAME_AUDIO_SCRIPT).toContain("opensession:audio");
    expect(FRAME_AUDIO_SCRIPT).toContain("opensession:pause-audio");
  });

  test("hears Web Audio sources until they end", () => {
    const page = fakePage();
    const context = new page.AudioContext();
    const music = new page.AudioBufferSourceNode(context);
    music.start();
    expect(page.posted).toEqual([true]);
    music.stop();
    expect(page.posted).toEqual([true, false]);
  });

  test("a suspended context is silent, and pause suspends it", () => {
    const page = fakePage();
    const context = new page.AudioContext();
    new page.AudioScheduledSourceNode(context).start();
    page.pause();
    expect(context.state).toBe("suspended");
    expect(page.posted).toEqual([true, false]);
  });

  test("hears an element that never joined the document", () => {
    const page = fakePage();
    const audio = new page.HTMLMediaElement();
    audio.play();
    expect(page.posted).toEqual([true]);
    page.pause();
    expect(audio.paused).toBe(true);
    expect(page.posted).toEqual([true, false]);
  });
});
