import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TeamMember } from "./config";
import { __setIdentitiesForTest } from "./shared/user-mappings";
import {
  resolveOwnerRef,
  slackThreadOwner,
  type SessionMeta,
} from "./analytics";
import { agentActor, workerActor } from "./session-actors";

function session(
  id: string,
  createdBy: string,
  extra: Partial<SessionMeta> = {},
): SessionMeta {
  return {
    id,
    createdAt: "2026-08-14T09:00:00.000Z",
    createdBy,
    createdByLogin: "",
    mode: "ask",
    model: "",
    branch: "",
    repo: null,
    automationName: null,
    goalId: null,
    parentSessionId: null,
    isReview: false,
    ...extra,
  };
}

const store = (...rows: SessionMeta[]) => new Map(rows.map((r) => [r.id, r]));

const HUMAN = "os-0000000000000000000000000000000a";
const CHILD = "os-0000000000000000000000000000000b";
const GRANDCHILD = "os-0000000000000000000000000000000c";

describe("session owner attribution", () => {
  test("a person owns their own session", () => {
    const kent = session(HUMAN, "Kent");
    expect(resolveOwnerRef(store(kent), kent)).toEqual({
      kind: "person",
      meta: kent,
    });
  });

  test("a delegated worker is credited to whoever delegated it", () => {
    const kent = session(HUMAN, "Kent");
    const worker = session(CHILD, workerActor(HUMAN), {
      parentSessionId: HUMAN,
    });
    expect(resolveOwnerRef(store(kent, worker), worker)).toEqual({
      kind: "person",
      meta: kent,
    });
  });

  test("credit survives a chain of machine sessions", () => {
    const kent = session(HUMAN, "Kent");
    const worker = session(CHILD, workerActor(HUMAN), {
      parentSessionId: HUMAN,
    });
    const nested = session(GRANDCHILD, agentActor(CHILD), {
      parentSessionId: CHILD,
    });
    expect(resolveOwnerRef(store(kent, worker, nested), nested)).toEqual({
      kind: "person",
      meta: kent,
    });
  });

  test("a missing parent link falls back to the id the sender names", () => {
    // The `worker <id>` string carries its own provenance, so a session
    // written without parentSessionId still reaches its person.
    const kent = session(HUMAN, "Kent");
    const worker = session(CHILD, workerActor(HUMAN));
    expect(resolveOwnerRef(store(kent, worker), worker)).toEqual({
      kind: "person",
      meta: kent,
    });
  });

  test("a chain ending on a machine is unattended work, never a person", () => {
    const machine = session(HUMAN, "Automation");
    expect(resolveOwnerRef(store(machine), machine)).toEqual({
      kind: "automation",
      name: "Automation",
    });
  });

  test("a pruned parent leaves the work unattended rather than inventing a person", () => {
    const worker = session(CHILD, workerActor(HUMAN), {
      parentSessionId: HUMAN,
    });
    expect(resolveOwnerRef(store(worker), worker)).toEqual({
      kind: "automation",
      name: "Worker sessions",
    });
  });

  test("a parent cycle terminates", () => {
    const a = session(HUMAN, workerActor(CHILD), { parentSessionId: CHILD });
    const b = session(CHILD, workerActor(HUMAN), { parentSessionId: HUMAN });
    expect(resolveOwnerRef(store(a, b), a).kind).toBe("automation");
  });

  test("a goal is unattended work under its own name", () => {
    const goal = session(HUMAN, "Improve Tella SEO visibility (goal)", {
      goalId: "goal-1",
    });
    expect(resolveOwnerRef(store(goal), goal)).toEqual({
      kind: "automation",
      name: "Improve Tella SEO visibility",
    });
  });

  test("automations and reviews keep their existing buckets", () => {
    const auto = session(HUMAN, "docs-sync (automation)", {
      automationName: "docs-sync",
    });
    expect(resolveOwnerRef(store(auto), auto)).toEqual({
      kind: "automation",
      name: "docs-sync",
    });
    const review = session(CHILD, "GitHub (automation)", { isReview: true });
    expect(resolveOwnerRef(store(review), review)).toEqual({
      kind: "automation",
      name: "GitHub review",
    });
  });

  test("a session a person spawned stays theirs", () => {
    // A human's own child session carries their name, so nothing rolls up.
    const kent = session(HUMAN, "Kent");
    const child = session(CHILD, "Kent", { parentSessionId: HUMAN });
    expect(resolveOwnerRef(store(kent, child), child)).toEqual({
      kind: "person",
      meta: child,
    });
  });
});

describe("Slack thread attribution", () => {
  const TEAM: TeamMember[] = [
    {
      name: "Johnny Lin",
      email: "johnny@example.com",
      aliases: ["johnny"],
      github: "johnnylinsf",
      slackId: "U08S8B3P83X",
    },
  ];
  let restore: (() => void) | undefined;
  beforeAll(() => {
    restore = __setIdentitiesForTest(TEAM);
  });
  afterAll(() => restore?.());

  const owners = new Map([
    ["slack-C1-1", "U08S8B3P83X"],
    ["slack-C1-2", "Johnny Lin"],
    ["slack-C1-3", "USLACKBOT"],
    ["slack-C1-4", "Slack"],
  ]);

  test("credits the teammate a thread names, by Slack id or display name", () => {
    // A thread lives in the Slack agent's own store, so it never reaches
    // the session store and used to land in an anonymous "Slack" row.
    expect(slackThreadOwner(owners, "slack-C1-1")).toBe("U08S8B3P83X");
    expect(slackThreadOwner(owners, "slack-C1-2")).toBe("Johnny Lin");
  });

  test("a name that is not a teammate stays on the surface row", () => {
    // A bot or a guest must not become a person, or the count is back to
    // inventing humans.
    expect(slackThreadOwner(owners, "slack-C1-3")).toBe(null);
    expect(slackThreadOwner(owners, "slack-C1-4")).toBe(null);
  });

  test("a thread with no recorded user stays on the surface row", () => {
    expect(slackThreadOwner(owners, "slack-C1-99")).toBe(null);
  });
});
