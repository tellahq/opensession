const { describe, expect, test } = require("bun:test");
const {
  readNetworkBinding,
  parseProfiles,
  createTailscaleClient,
  connectOrganizationNetwork,
  createLatestSwitchQueue,
} = require("./tailscale");

const profiles = [
  {
    id: "personal",
    account: "person@example.test",
    tailnet: "Personal",
    selected: true,
  },
  { id: "work", account: "person@work.test", tailnet: "Work", selected: false },
];
const account = {
  id: "org",
  label: "Work",
  url: "https://os.work.test/",
  network: { profileId: "work", mode: "ask" },
};

function fixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    options: {
      account,
      client: {
        list: async () => {
          calls.push("list");
          return profiles;
        },
        switch: async (id) => {
          calls.push(`switch:${id}`);
        },
        ready: async (id) => {
          calls.push(`ready:${id}`);
        },
      },
      confirm: async () => {
        calls.push("confirm");
        return true;
      },
      probe: async (url) => {
        calls.push(`probe:${url}`);
        return { ok: true };
      },
      isCurrent: () => true,
      status: () => {},
      ...overrides,
    },
  };
}

describe("local network binding", () => {
  test("keeps only a saved profile ID and an explicit mode", () => {
    expect(
      readNetworkBinding({ ...account.network, token: "not-stored" }),
    ).toEqual(account.network);
    for (const value of [
      null,
      {},
      { profileId: "--logout", mode: "ask" },
      { profileId: "work", mode: "yes" },
    ]) {
      expect(readNetworkBinding(value)).toBeNull();
    }
  });
  test("rejects malformed CLI data", () => {
    expect(parseProfiles(JSON.stringify(profiles))).toEqual(profiles);
    for (const value of [
      null,
      {},
      [null],
      [{ id: "a" }],
      [{ ...profiles[0], selected: "yes" }],
    ]) {
      expect(() => parseProfiles(JSON.stringify(value))).toThrow();
    }
  });
});

describe("Tailscale driver", () => {
  test("uses the app binary and exact argv, then verifies readiness", async () => {
    const calls = [];
    const client = createTailscaleClient({
      platform: "darwin",
      run: async (binary, args, options) => {
        calls.push({ binary, args, options });
        return {
          stdout: JSON.stringify(
            args[0] === "status" ? { BackendState: "Running" } : profiles,
          ),
        };
      },
    });
    await client.switch("work");
    await client.ready("personal", () => true);
    expect(calls.map(({ args }) => args)).toEqual([
      ["switch", "--list", "--json"],
      ["switch", "work"],
      ["switch", "--list", "--json"],
      ["status", "--json"],
    ]);
    expect(
      calls.every(
        ({ binary, options }) =>
          binary === "/Applications/Tailscale.app/Contents/MacOS/Tailscale" &&
          options.timeout > 0 &&
          !options.shell,
      ),
    ).toBe(true);
  });
  test("does not execute arbitrary or removed IDs", async () => {
    const calls = [];
    const client = createTailscaleClient({
      platform: "darwin",
      run: async (_binary, args) => {
        calls.push(args);
        return { stdout: JSON.stringify(profiles) };
      },
    });
    await expect(client.switch("--help")).rejects.toThrow("no longer saved");
    expect(calls).toEqual([["switch", "--list", "--json"]]);
  });
  test("does not switch if superseded during profile revalidation", async () => {
    let current = true;
    const calls = [];
    const client = createTailscaleClient({
      platform: "darwin",
      run: async (_binary, args) => {
        calls.push(args);
        current = false;
        return { stdout: JSON.stringify(profiles) };
      },
    });
    await client.switch("work", () => current);
    expect(calls).toEqual([["switch", "--list", "--json"]]);
  });
  test("only falls back for missing binaries, not daemon or permission errors", async () => {
    const paths = [];
    const client = createTailscaleClient({
      platform: "darwin",
      run: async (binary) => {
        paths.push(binary);
        if (paths.length === 1)
          throw Object.assign(new Error(), { code: "ENOENT" });
        throw new Error("permission denied");
      },
    });
    await expect(client.list()).rejects.toThrow("Couldn't control Tailscale");
    expect(paths).toHaveLength(2);
  });
  test("reports missing installation", async () => {
    const client = createTailscaleClient({
      platform: "darwin",
      run: async () => {
        throw Object.assign(new Error(), { code: "ENOENT" });
      },
    });
    await expect(client.list()).rejects.toThrow("Install Tailscale");
  });
  test("selected but stopped is not ready and has a bounded retry", async () => {
    let polls = 0;
    const client = createTailscaleClient({
      platform: "darwin",
      wait: async () => {},
      run: async (_binary, args) => {
        if (args[0] === "status") polls++;
        return {
          stdout: JSON.stringify(
            args[0] === "status" ? { BackendState: "Stopped" } : profiles,
          ),
        };
      },
    });
    await expect(client.ready("personal", () => true)).rejects.toThrow(
      "isn't connected",
    );
    expect(polls).toBe(12);
  });
});

describe("organization switching", () => {
  test("unmapped organizations leave Tailscale alone", async () => {
    const { options, calls } = fixture({
      account: { ...account, network: null },
    });
    await connectOrganizationNetwork(options);
    expect(calls).toEqual([]);
  });
  test("asks, switches, verifies readiness, then probes the destination", async () => {
    const { options, calls } = fixture();
    expect(await connectOrganizationNetwork(options)).toBe(true);
    expect(calls).toEqual([
      "list",
      "confirm",
      "switch:work",
      "ready:work",
      "probe:https://os.work.test/",
    ]);
  });
  test("automatic mode skips the confirmation", async () => {
    const { options, calls } = fixture({
      account: {
        ...account,
        network: { profileId: "work", mode: "automatic" },
      },
    });
    expect(await connectOrganizationNetwork(options)).toBe(true);
    expect(calls).not.toContain("confirm");
  });
  test("an already active profile is checked but not switched", async () => {
    const { options, calls } = fixture({
      account: { ...account, network: { profileId: "personal", mode: "ask" } },
    });
    expect(await connectOrganizationNetwork(options)).toBe(true);
    expect(calls).toEqual([
      "list",
      "ready:personal",
      "probe:https://os.work.test/",
    ]);
  });
  test("cancelling the confirmation does not switch or probe", async () => {
    const { options, calls } = fixture({ confirm: async () => false });
    expect(await connectOrganizationNetwork(options)).toBe(false);
    expect(calls).toEqual(["list"]);
  });
  test("a removed account fails without switching", async () => {
    const { options, calls } = fixture({
      account: {
        ...account,
        network: { profileId: "gone", mode: "automatic" },
      },
    });
    await expect(connectOrganizationNetwork(options)).rejects.toThrow(
      "no longer saved",
    );
    expect(calls).toEqual(["list"]);
  });
  test("an unreachable destination doesn't complete the organization switch", async () => {
    const { options } = fixture({ probe: async () => ({ ok: false }) });
    await expect(connectOrganizationNetwork(options)).rejects.toThrow(
      "isn't reachable",
    );
  });
  test("a superseded confirmation cannot switch networks", async () => {
    let current = true;
    const { options, calls } = fixture({
      confirm: async () => {
        current = false;
        return true;
      },
      isCurrent: () => current,
    });
    await connectOrganizationNetwork(options);
    expect(calls).toEqual(["list"]);
  });
  test("a superseded network command cannot probe or activate", async () => {
    let current = true;
    const { options, calls } = fixture({ isCurrent: () => current });
    options.client.switch = async () => {
      current = false;
    };
    expect(await connectOrganizationNetwork(options)).not.toBe(true);
    expect(calls).toEqual(["list", "confirm"]);
  });
  test("serializes across windows and skips intermediate selections", async () => {
    const queue = createLatestSwitchQueue();
    const calls = [];
    const started = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const first = queue(async (isCurrent) => {
      started.resolve();
      calls.push("first:start");
      await finish.promise;
      if (isCurrent()) calls.push("first:activate");
      calls.push("first:end");
    });
    await started.promise;
    const middle = queue(async () => calls.push("middle"));
    const last = queue(async () => calls.push("last"));
    finish.resolve();
    await Promise.all([first, middle, last]);
    expect(calls).toEqual(["first:start", "first:end", "last"]);
  });
  test("a failed request does not poison the queue", async () => {
    const queue = createLatestSwitchQueue();
    await expect(
      queue(async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(await queue(async () => "next")).toBe("next");
  });
});
