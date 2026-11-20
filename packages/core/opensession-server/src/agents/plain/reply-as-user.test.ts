import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sendCustomerReply } from "./api";

type Call = { query: string; input: Record<string, any> };

let calls: Call[] = [];
let respond: (call: Call) => Response;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { input?: Record<string, any> } & Record<string, any>;
    };
    const call = {
      query: body.query,
      input: body.variables?.input ?? body.variables ?? {},
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ok = (name: string) =>
  Response.json({
    data: {
      [name]:
        name === "snoozeThread"
          ? { thread: { id: "th_1" }, error: null }
          : { error: null },
    },
  });
const mutationError = (name: string, code: string) =>
  Response.json({
    data: {
      [name]: {
        // No __typename: what a raw query sees when it does not select it.
        error: {
          message: `refused: ${code}`,
          type: "VALIDATION",
          code,
          fields: [],
        },
      },
    },
  });

const replies = () => calls.filter((c) => /replyToThread/.test(c.query));
const isImpersonated = (c: Call) => !!c.input.impersonation;
const snoozeOrReply = (call: Call) =>
  /snoozeThread/.test(call.query) ? ok("snoozeThread") : ok("replyToThread");

describe("sendCustomerReply as a Plain user", () => {
  it("sends as the team member through impersonation, without the sign-off", async () => {
    respond = snoozeOrReply;
    const result = await sendCustomerReply("th_1", "c_1", "Fixed now.", {
      asUser: [{ emailAddress: "sam@acme.test" }],
      machineUserText: "Fixed now.\n\nSam",
    });
    expect(result).toMatchObject({
      ok: true,
      sentAs: "user",
      waitingForCustomer: true,
    });
    expect(replies()).toHaveLength(1);
    expect(replies()[0].input).toMatchObject({
      threadId: "th_1",
      textContent: "Fixed now.",
      impersonation: {
        asUser: { userIdentifier: { emailAddress: "sam@acme.test" } },
      },
    });
  });

  it("tries the next email when Plain has no user for the first", async () => {
    respond = (call) => {
      if (/snoozeThread/.test(call.query)) return ok("snoozeThread");
      const email =
        call.input.impersonation?.asUser?.userIdentifier?.emailAddress;
      return email === "sam@personal.test"
        ? mutationError("replyToThread", "not_found")
        : ok("replyToThread");
    };
    const result = await sendCustomerReply("th_1", "c_1", "Hi", {
      asUser: [
        { emailAddress: "sam@personal.test" },
        { emailAddress: "sam@acme.test" },
      ],
    });
    expect(result).toMatchObject({ ok: true, sentAs: "user" });
    expect(replies().map((c) => c.input.impersonation.asUser)).toEqual([
      { userIdentifier: { emailAddress: "sam@personal.test" } },
      { userIdentifier: { emailAddress: "sam@acme.test" } },
    ]);
  });

  it("falls back to the machine user with the sign-off when Plain refuses impersonation", async () => {
    respond = (call) => {
      if (/snoozeThread/.test(call.query)) return ok("snoozeThread");
      return isImpersonated(call)
        ? mutationError("replyToThread", "cannot_reply_to_thread")
        : ok("replyToThread");
    };
    const result = await sendCustomerReply("th_1", "c_1", "Hi", {
      asUser: [{ userId: "u_sam" }, { emailAddress: "sam@acme.test" }],
      machineUserText: "Hi\n\nSam",
    });
    expect(result.ok).toBe(true);
    expect(result.sentAs).toBe("system");
    expect(result.impersonationError).toContain("cannot_reply_to_thread");
    // A refusal is about impersonation itself: no second identity is tried.
    expect(replies().filter(isImpersonated)).toHaveLength(1);
    const machine = replies().filter((c) => !isImpersonated(c));
    expect(machine).toHaveLength(1);
    expect(machine[0].input.textContent).toBe("Hi\n\nSam");
  });

  it("does not resend as the machine user when Plain's answer is unclear", async () => {
    respond = () => new Response("{}", { status: 500 });
    const result = await sendCustomerReply("th_1", "c_1", "Hi", {
      asUser: [{ userId: "u_sam" }],
    });
    expect(result).toMatchObject({ ok: false, sentAs: "user" });
    expect(replies()).toHaveLength(1);
  });

  it("sends as the machine user when no team member is given", async () => {
    respond = snoozeOrReply;
    const result = await sendCustomerReply("th_1", "c_1", "Hi");
    expect(result).toMatchObject({ ok: true, sentAs: "system" });
    expect(replies()).toHaveLength(1);
    expect(isImpersonated(replies()[0])).toBe(false);
  });
});
