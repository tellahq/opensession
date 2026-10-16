import { publishClientDataIdentity } from "./client-data-scope";
import { afterEach, expect, test } from "bun:test";
import {
  sessionAgentName,
  sessionAgentTitle,
  setSessionTitles,
  setResolvedSessionTitles,
  resetResolvedSessionTitles,
  onSessionTitlesChanged,
  onSessionTitleResolutionRequested,
} from "./markdown";
afterEach(() => {
  setSessionTitles([]);
  resetResolvedSessionTitles();
});

test("agents use their own full session title, including workers and aliases", () => {
  setSessionTitles([
    ["root", "Workspace", false, "Fix retries"],
    ["child", "Check cancellation", false, null, ["child-alias"], "root"],
  ]);
  expect(sessionAgentName("root")).toBe("Fix retries");
  expect(sessionAgentName("child")).toBe("Check cancellation");
  expect(sessionAgentName("child-alias")).toBe("Check cancellation");
  expect(sessionAgentTitle("root")).toBe("Fix retries");
});

test("missing titles have honest placeholders, not generated names or IDs", () => {
  setSessionTitles([["untitled", ""]]);
  expect(sessionAgentName("untitled")).toBe("Untitled session");
  expect(sessionAgentName("unknown")).toBe("Session");
});

test("archived titles resolve on demand and notify subscribed agent labels", async () => {
  const requests: string[] = [];
  const stopRequests = onSessionTitleResolutionRequested((ids) =>
    requests.push(...ids),
  );
  let updates = 0;
  const stopUpdates = onSessionTitlesChanged(() => updates++);
  try {
    expect(sessionAgentName("archived")).toBe("Session");
    await Promise.resolve();
    expect(requests).toContain("archived");
    setResolvedSessionTitles([
      {
        requestedId: "archived",
        id: "archived",
        title: "Old workspace",
        tabTitle: "Inspect retry failures",
        archived: true,
      },
    ]);
    expect(sessionAgentName("archived")).toBe("Inspect retry failures");
    expect(updates).toBe(1);
  } finally {
    stopRequests();
    stopUpdates();
  }
});

test("renames update labels while identical polls remain no-ops", () => {
  setSessionTitles([["id", "Before"]]);
  let updates = 0;
  const stop = onSessionTitlesChanged(() => updates++);
  try {
    setSessionTitles([["id", "After"]]);
    setSessionTitles([["id", "After"]]);
    expect(sessionAgentName("id")).toBe("After");
    expect(updates).toBe(1);
  } finally {
    stop();
  }
});

test("late session titles never replace an author's explicit link label", () => {
  const generated = { textContent: "Session" };
  const authored = { textContent: "My helper" };
  const anchor = (label: typeof generated, source?: string) => ({
    dataset: { sessionId: "child", sessionLabel: source },
    title: "",
    querySelector: () => label,
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelectorAll: () => [anchor(generated), anchor(authored, "authored")],
    },
  });
  try {
    setSessionTitles([["child", "Check cancellation"]]);
    expect(generated.textContent).toBe("Check cancellation");
    expect(authored.textContent).toBe("My helper");
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("numeric identity replacement clears private agent and hover titles", () => {
  const identify = (githubAccountId: number) =>
    publishClientDataIdentity({
      required: true,
      authenticated: true,
      githubAccountId,
      login: "same-login",
    });
  try {
    identify(101);
    setSessionTitles([["private-root", "Private root task"]]);
    setResolvedSessionTitles([
      {
        requestedId: "private-child-alias",
        id: "private-child",
        title: "Private child task",
        parentSessionId: "private-root",
      },
    ]);
    expect(sessionAgentName("private-child-alias")).toBe("Private child task");
    expect(sessionAgentTitle("private-child-alias")).toBe("Private child task");
    identify(202);
    expect(sessionAgentTitle("private-child-alias")).toBe("");
    expect(sessionAgentTitle("private-root")).toBe("");
    expect(sessionAgentName("private-child")).toBe("Session");
    expect(sessionAgentName("private-child-alias")).toBe("Session");
  } finally {
    publishClientDataIdentity(null);
  }
});
