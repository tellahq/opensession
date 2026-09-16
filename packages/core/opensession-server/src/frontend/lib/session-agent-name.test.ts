import { publishClientDataIdentity } from "./client-data-scope";
import { afterEach, expect, test } from "bun:test";
import { agentIdentity } from "./agent-identity";
import {
  sessionAgentName,
  sessionAgentTitle,
  sessionTitleFor,
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

test("children and grandchildren share a root surname, peers do not", () => {
  setSessionTitles([
    ["main", "Main"],
    ["child", "Worker", false, null, ["child-alias"], "main"],
    ["grandchild", "Nested worker", false, null, undefined, "child"],
    ["peer", "Peer"],
  ]);
  expect(sessionAgentName("main")).toBe(agentIdentity("main").name);
  expect(sessionAgentName("child")).toBe(agentIdentity("child", "main").name);
  expect(sessionAgentName("child-alias")).toBe(sessionAgentName("child"));
  expect(sessionAgentName("grandchild")).toBe(
    agentIdentity("grandchild", "main").name,
  );
  expect(sessionAgentName("peer")).toBe(agentIdentity("peer").name);
  expect(sessionAgentName("peer").split(" ")[1]).not.toBe(
    sessionAgentName("main").split(" ")[1],
  );
  expect(sessionTitleFor("child")).toBe("Worker");
});

test("untitled workers use the family name for session references", () => {
  setSessionTitles([["child", "", false, null, undefined, "main"]]);
  expect(sessionTitleFor("child")).toBe(agentIdentity("child", "main").name);
});

test("late archived ancestry updates subscribers without changing task titles", async () => {
  const requested: string[] = [];
  const stopRequests = onSessionTitleResolutionRequested((ids) =>
    requested.push(...ids),
  );
  let updates = 0;
  const stopUpdates = onSessionTitlesChanged(() => updates++);
  try {
    expect(sessionAgentName("child")).toBe(agentIdentity("child").name);
    await Promise.resolve();
    expect(requested).toContain("child");
    setResolvedSessionTitles([
      {
        requestedId: "child",
        id: "child",
        title: "Archived work",
        parentSessionId: "middle",
        archived: true,
      },
    ]);
    expect(sessionAgentName("child")).toBe(
      agentIdentity("child", "middle").name,
    );
    await Promise.resolve();
    expect(requested).toContain("middle");
    setResolvedSessionTitles([
      {
        requestedId: "middle",
        id: "middle",
        title: "",
        parentSessionId: "main",
        archived: true,
      },
    ]);
    expect(sessionAgentName("child")).toBe(agentIdentity("child", "main").name);
    expect(sessionTitleFor("child")).toBe("Archived work");
    expect(updates).toBe(2);
  } finally {
    stopRequests();
    stopUpdates();
  }
});

test("a parent-only metadata change notifies names, unchanged polls do not", () => {
  setSessionTitles([["child", "Work"]]);
  let updates = 0;
  const stop = onSessionTitlesChanged(() => updates++);
  try {
    const rows = [["child", "Work", false, null, undefined, "main"]] as const;
    setSessionTitles(rows);
    setSessionTitles(rows);
    expect(updates).toBe(1);
    expect(sessionAgentName("child")).toBe(agentIdentity("child", "main").name);
  } finally {
    stop();
  }
});

test("unknown parents and malformed cycles terminate without inventing identities", () => {
  setSessionTitles([
    ["child", "Child", false, null, undefined, "missing"],
    ["a", "A", false, null, undefined, "b"],
    ["b", "B", false, null, undefined, "a"],
  ]);
  expect(sessionAgentName("child")).toBe(
    agentIdentity("child", "missing").name,
  );
  expect(sessionAgentName("a")).toBe(agentIdentity("a").name);
  expect(sessionAgentName("unknown")).toBe(agentIdentity("unknown").name);
});

test("late family metadata updates generated chips but preserves authored labels", () => {
  const generated = { textContent: "old" };
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
    setSessionTitles([["child", "", false, null, undefined, "main"]]);
    expect(generated.textContent).toBe(agentIdentity("child", "main").name);
    expect(authored.textContent).toBe("My helper");
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("agent hover names the full session task, not the workspace or a truncated chip", () => {
  const task =
    "Investigate the final retry failure and preserve the original upload error";
  setSessionTitles([["main", "Upload reliability", false, task]]);
  expect(sessionAgentTitle("main")).toBe(task);
  setResolvedSessionTitles([
    {
      requestedId: "worker",
      id: "worker",
      title: "Worker task",
      parentSessionId: "main",
    },
  ]);
  expect(sessionAgentTitle("worker")).toBe("Worker task");
  expect(sessionAgentTitle("missing")).toBe("");
});

test("numeric identity replacement clears private family ancestry and hover titles", () => {
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
    expect(sessionAgentName("private-child")).toBe(
      agentIdentity("private-child", "private-root").name,
    );
    expect(sessionAgentTitle("private-child-alias")).toBe("Private child task");
    identify(202);
    expect(sessionAgentTitle("private-child-alias")).toBe("");
    expect(sessionAgentTitle("private-root")).toBe("");
    expect(sessionAgentName("private-child")).toBe(
      agentIdentity("private-child").name,
    );
    expect(sessionAgentName("private-child-alias")).toBe(
      agentIdentity("private-child-alias").name,
    );
  } finally {
    publishClientDataIdentity(null);
  }
});
