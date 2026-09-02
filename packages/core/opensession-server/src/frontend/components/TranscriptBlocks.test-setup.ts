// A sibling test may already have installed a partial `window`. Fill in this
// file's browser surface without replacing it or depending on test order.
const testWindow = Object.assign(globalThis.window ?? {}, {
  addEventListener: () => {},
  matchMedia: () => ({ matches: false }),
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  writable: true,
  value: testWindow,
});

const testDocument = Object.assign(globalThis.document ?? {}, {
  documentElement: { dataset: {}, style: {} },
  querySelector: () => null,
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  writable: true,
  value: testDocument,
});

const testLocalStorage = Object.assign(globalThis.localStorage ?? {}, {
  getItem: (_key: string) => null,
  setItem: (_key: string, _value: string) => {},
  removeItem: (_key: string) => {},
});
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: testLocalStorage,
});

let turnWork: string | null = null;
let toolCalls: string | null = null;
let thinkingMessages: string | null = null;

globalThis.localStorage.getItem = (key) => {
  if (key === "opensession-turn-activity") return turnWork;
  if (key === "opensession-tool-calls") return toolCalls;
  if (key === "opensession-thinking-messages") return thinkingMessages;
  return null;
};

/** The two work preferences as the browser store holds them. */
export function setTurnPrefs(work: string | null, tools: string | null = null) {
  turnWork = work;
  toolCalls = tools;
}

/** Which provider thinking rows the transcript keeps on screen. */
export function setThinkingMessagesPref(value: string | null) {
  thinkingMessages = value;
}
