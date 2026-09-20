const { expect, test } = require("bun:test");
const { MacKeychainReview, reviewOptions } = require("./mac-keychain-ui");

const intent = {
  account: "demo@example.test",
  service: "Example API",
  purpose: "Check authentication",
  url: "https://api.example.com/me",
  method: "GET",
  injection: "bearer",
};
function harness({ approve = 1, claimFails = false, navigate = false } = {}) {
  const record = {
    id: crypto.randomUUID(),
    sessionId: "session-test",
    login: "alice",
    intent,
    expiresAt: Date.now() + 600_000,
  };
  const claim = crypto.randomUUID();
  const calls = [];
  const dialogs = [];
  let moved = false;
  let executions = 0;
  const target = {
    isDestroyed: () => false,
    webContents: {
      session: {
        fetch: async (url, options) => {
          calls.push({ url, options });
          if (url.includes("/pending?"))
            return Response.json({ request: record });
          if (url.endsWith("/claim"))
            return Response.json({ claim }, { status: claimFails ? 409 : 200 });
          return Response.json({ ok: true });
        },
      },
    },
  };
  const reviewer = new MacKeychainReview({
    approve: async (_target, options) => {
      dialogs.push(options);
      if (navigate) moved = true;
      return { response: approve };
    },
    dialog: {
      showMessageBox: async (_target, options) => {
        dialogs.push(options);
        return { response: 0 };
      },
    },
    context: () =>
      moved
        ? null
        : {
            origin: "https://os.example.com",
            sessionId: record.sessionId,
            pageUrl: "https://os.example.com/session/session-test",
          },
    execute: async (input) => {
      executions++;
      expect(input).toEqual(intent);
      return { status: "completed", httpStatus: 200 };
    },
  });
  return {
    reviewer,
    target,
    calls,
    dialogs,
    record,
    executions: () => executions,
  };
}

test("request selection shows exact service, account, purpose and destination before Apple authorization", () => {
  const options = reviewOptions(
    { sessionId: "session-test", login: "alice", intent },
    "https://os.example.com",
  );
  for (const value of Object.values(intent))
    expect(options.detail.toLowerCase()).toContain(value.toLowerCase());
  expect(options.detail).toContain("Only HTTP status returns");
  expect(options.detail).toContain("Allow for one-time access");
});

test("approves once, claims before execution and posts only the fixed result", async () => {
  const h = harness();
  await h.reviewer.review(h.target);
  expect(h.executions()).toBe(1);
  expect(h.calls.length).toBe(3);
  expect(h.calls[1].url).toEndWith("/claim");
  const complete = JSON.parse(h.calls[2].options.body);
  expect(complete.outcome).toEqual({ status: "completed", httpStatus: 200 });
  for (const call of h.calls) {
    expect(call.options.redirect).toBe("error");
    expect(call.options.credentials).toBe("include");
  }
});

test("decline, concurrent claims, expiry and navigation never unlock macOS Keychain", async () => {
  for (const options of [
    { approve: 0 },
    { claimFails: true },
    { navigate: true },
  ]) {
    const h = harness(options);
    await h.reviewer.review(h.target);
    expect(h.executions()).toBe(0);
  }
  const expired = harness();
  expired.record.expiresAt = Date.now() - 1;
  await expired.reviewer.review(expired.target);
  expect(expired.executions()).toBe(0);
  expect(expired.calls.length).toBe(1);
});

test("simultaneous menu clicks cannot race approval", async () => {
  const h = harness();
  await Promise.all([h.reviewer.review(h.target), h.reviewer.review(h.target)]);
  expect(h.executions()).toBe(1);
});
