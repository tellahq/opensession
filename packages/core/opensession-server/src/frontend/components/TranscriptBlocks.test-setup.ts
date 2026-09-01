// A sibling test may already have installed a partial `window`. Fill in this
// file's browser surface without replacing it or depending on test order.
Object.assign(
  ((globalThis as unknown as { window?: Record<string, unknown> }).window ??=
    {}),
  {
    addEventListener: () => {},
    matchMedia: () => ({ matches: false }),
  },
);
Object.assign(
  ((
    globalThis as unknown as { document?: Record<string, unknown> }
  ).document ??= {}),
  {
    documentElement: { dataset: {}, style: {} },
    querySelector: () => null,
  },
);
Object.assign(
  ((
    globalThis as unknown as { localStorage?: Record<string, unknown> }
  ).localStorage ??= {}),
  {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
);

let turnWork: string | null = null;
let toolCalls: string | null = null;
let thinkingMessages: string | null = null;

(
  globalThis.localStorage as { getItem: (key: string) => string | null }
).getItem = (key) => {
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
