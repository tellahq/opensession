import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_CONTINUE_USER } from "./auto-continue";
import { importApplicationCatalog } from "./catalog-documents";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import { getPersonalOutputStyle } from "./personal-output-style";
import {
  getPersonalPrompt,
  MAX_PERSONAL_PROMPT_LENGTH,
  setPersonalPrompt,
} from "./personal-prompts";
import {
  agentActor,
  GITHUB_ACTOR,
  SYSTEM_RESTART_USER,
  workerActor,
} from "./session-actors";
import {
  createSettingsMcpServer,
  personalSettingsMcpServers,
} from "./settings-mcp";

const root = mkdtempSync(join(tmpdir(), "settings-mcp-test-"));
const previousRoot = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;
afterAll(() => {
  if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
});
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});
beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  for (const name of ["personal-prompts", "personal-output-styles"]) {
    rmSync(join(root, `.opensession-${name}`), {
      recursive: true,
      force: true,
    });
  }
});

const user = "settings-test-alex";
const other = "settings-test-blair";

async function connect(who = user) {
  const server = createSettingsMcpServer(who);
  const client = new Client({ name: "settings-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(remote);
  await client.connect(local);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = CallToolResultSchema.parse(
        await client.callTool({ name, arguments: args }),
      );
      const text = result.content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n");
      return { isError: result.isError, text };
    },
    async [Symbol.asyncDispose]() {
      await client.close();
      await server.instance.close();
    },
  };
}

const append = (text: string) => ({ change: { operation: "append", text } });
const replace = (text: string, expected: string) => ({
  change: { operation: "replace", text, expected },
});

describe("personal settings MCP", () => {
  test("catalog exposes only personal settings, with no target identity", async () => {
    await using mcp = await connect();
    const { tools } = await mcp.client.listTools();
    expect(tools.map((entry) => entry.name)).toEqual([
      "get_settings",
      "update_personal_prompt",
      "set_output_style",
    ]);
    for (const entry of tools) {
      expect(entry.inputSchema.properties).not.toHaveProperty("user");
      expect(entry.inputSchema.properties).not.toHaveProperty("sessionId");
    }
    expect(JSON.parse((await mcp.call("get_settings")).text)).toEqual({
      personalPrompt: "",
      outputStyle: "default",
      maxPersonalPromptLength: MAX_PERSONAL_PROMPT_LENGTH,
    });
  });

  test("legacy prompts and styles survive import and shadow stale files after editing", async () => {
    for (const [name, value] of [
      ["personal-prompts", { prompt: "Existing instructions." }],
      ["personal-output-styles", { outputStyle: "concise" }],
    ] as const) {
      const directory = join(root, `.opensession-${name}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, `user-${user}.json`),
        JSON.stringify(value),
      );
    }
    await importApplicationCatalog();
    await using mcp = await connect(user.toUpperCase());
    const read = JSON.parse((await mcp.call("get_settings")).text);
    expect(read.personalPrompt).toBe("Existing instructions.");
    expect(read.outputStyle).toBe("concise");
    expect(
      (
        await mcp.call(
          "update_personal_prompt",
          replace("", "Existing instructions."),
        )
      ).isError,
    ).toBeFalsy();
    await importApplicationCatalog();
    expect(await getPersonalPrompt(user)).toBe("");
  });

  test("append preserves existing instructions and is retry-safe", async () => {
    await setPersonalPrompt(user, "Keep existing instructions.");
    await using mcp = await connect();
    const result = await mcp.call(
      "update_personal_prompt",
      append("  Report results briefly.  "),
    );
    expect(result.isError).toBeFalsy();
    expect(await getPersonalPrompt(user)).toBe(
      "Keep existing instructions.\n\nReport results briefly.",
    );
    await mcp.call("update_personal_prompt", append("Report results briefly."));
    expect(await getPersonalPrompt(user)).toBe(
      "Keep existing instructions.\n\nReport results briefly.",
    );
    await using fresh = await connect();
    expect((await fresh.call("get_settings")).text).toContain(
      "Report results briefly.",
    );
  });

  test("tool arguments cannot read or change another person's settings", async () => {
    await setPersonalPrompt(other, "Private instructions for Blair.");
    await using mcp = await connect();
    expect(
      (await mcp.call("get_settings", { user: other })).text,
    ).not.toContain("Private instructions");
    await mcp.call("update_personal_prompt", {
      ...append("Alex's instructions."),
      user: other,
    });
    await mcp.call("set_output_style", { outputStyle: "concise", user: other });
    expect(await getPersonalPrompt(user)).toBe("Alex's instructions.");
    expect(await getPersonalPrompt(other)).toBe(
      "Private instructions for Blair.",
    );
    expect(await getPersonalOutputStyle(user)).toBe("concise");
    expect(await getPersonalOutputStyle(other)).toBe("default");
  });

  test("each sender in a shared conversation gets a fresh identity", async () => {
    await using alex = await connect(user);
    await using blair = await connect(other);
    await alex.call("update_personal_prompt", append("Alex only."));
    await blair.call("update_personal_prompt", append("Blair only."));
    expect(await getPersonalPrompt(user)).toBe("Alex only.");
    expect(await getPersonalPrompt(other)).toBe("Blair only.");
  });

  test("replacement and clearing reject stale reads", async () => {
    await setPersonalPrompt(user, "Original.");
    await using mcp = await connect();
    await setPersonalPrompt(user, "Edited in the browser.");
    expect(
      (
        await mcp.call(
          "update_personal_prompt",
          replace("Replacement.", "Original."),
        )
      ).isError,
    ).toBe(true);
    expect(await getPersonalPrompt(user)).toBe("Edited in the browser.");
    expect(
      (
        await mcp.call(
          "update_personal_prompt",
          replace("Replacement.", "Edited in the browser."),
        )
      ).isError,
    ).toBeFalsy();
    expect(
      (await mcp.call("update_personal_prompt", replace("", "Replacement.")))
        .isError,
    ).toBeFalsy();
    expect(await getPersonalPrompt(user)).toBe("");
  });

  test("append reads the latest prompt instead of a cached snapshot", async () => {
    await using mcp = await connect();
    await mcp.call("get_settings");
    await setPersonalPrompt(user, "A concurrent browser edit.");
    await mcp.call("update_personal_prompt", append("Agent addition."));
    expect(await getPersonalPrompt(user)).toBe(
      "A concurrent browser edit.\n\nAgent addition.",
    );
  });

  test("overflow is rejected rather than truncating existing instructions", async () => {
    const original = "a".repeat(MAX_PERSONAL_PROMPT_LENGTH);
    await setPersonalPrompt(user, original);
    await using mcp = await connect();
    expect(
      (await mcp.call("update_personal_prompt", append("Another instruction.")))
        .isError,
    ).toBe(true);
    expect(await getPersonalPrompt(user)).toBe(original);
    expect(
      (
        await mcp.call(
          "update_personal_prompt",
          replace(`${original}x`, original),
        )
      ).isError,
    ).toBe(true);
    expect(await getPersonalPrompt(user)).toBe(original);
  });

  test("invalid operations and styles cannot mutate storage", async () => {
    await using mcp = await connect();
    for (const args of [
      { change: { operation: "replace", text: "Missing expected." } },
      { change: { operation: "delete" } },
      append("   "),
      { change: { operation: "append", text: "Instruction", user: other } },
    ]) {
      expect((await mcp.call("update_personal_prompt", args)).isError).toBe(
        true,
      );
    }
    expect(
      (await mcp.call("set_output_style", { outputStyle: "anything" })).isError,
    ).toBe(true);
    expect(await getPersonalPrompt(user)).toBe("");
    expect(await getPersonalOutputStyle(user)).toBe("default");
  });

  test("output style persists without touching the prompt", async () => {
    await setPersonalPrompt(user, "Unchanged.");
    await using mcp = await connect();
    expect(
      (await mcp.call("set_output_style", { outputStyle: "concise" })).isError,
    ).toBeFalsy();
    expect(await getPersonalOutputStyle(user)).toBe("concise");
    expect(
      (await mcp.call("set_output_style", { outputStyle: "default" })).isError,
    ).toBeFalsy();
    expect(await getPersonalOutputStyle(user)).toBe("default");
    expect(await getPersonalPrompt(user)).toBe("Unchanged.");
  });

  test("read failures are errors, never an empty prompt to overwrite", async () => {
    await setPersonalPrompt(user, "Preserve me.");
    store.catalogDocumentGetMany = () => {
      throw new Error("Catalog unavailable");
    };
    await using mcp = await connect();
    expect((await mcp.call("get_settings")).isError).toBe(true);
    expect(
      (await mcp.call("update_personal_prompt", append("Do not overwrite.")))
        .isError,
    ).toBe(true);
  });

  test("concurrent appends preserve both instructions", async () => {
    await using first = await connect();
    await using second = await connect();
    const results = await Promise.all([
      first.call("update_personal_prompt", append("First instruction.")),
      second.call("update_personal_prompt", append("Second instruction.")),
    ]);
    for (const result of results) expect(result.isError).toBeFalsy();
    expect(await getPersonalPrompt(user)).toBe(
      "First instruction.\n\nSecond instruction.",
    );
  });

  test("failed writes are errors, never a saved confirmation", async () => {
    store.putCatalogDocument = () => {
      throw new Error("Catalog unavailable");
    };
    await using mcp = await connect();
    expect(
      (await mcp.call("update_personal_prompt", append("Cannot save.")))
        .isError,
    ).toBe(true);
    expect(
      (await mcp.call("set_output_style", { outputStyle: "concise" })).isError,
    ).toBe(true);
  });
});

describe("personal settings identity gate", () => {
  const sessionId = "os-01a00000-0000-7000-8000-000000000001";
  for (const actor of [
    undefined,
    "",
    "  ",
    AUTO_CONTINUE_USER,
    SYSTEM_RESTART_USER,
    GITHUB_ACTOR,
    "Automation",
    workerActor(sessionId),
    agentActor(sessionId),
  ]) {
    test(`withholds settings from ${actor ?? "missing identity"}`, () => {
      expect(personalSettingsMcpServers(actor)).toEqual({});
      expect(() => createSettingsMcpServer(actor ?? "")).toThrow(
        "human prompting user",
      );
    });
  }
  test("a human needs no admin privilege or browser token", async () => {
    const servers = personalSettingsMcpServers(user);
    expect(Object.keys(servers)).toEqual(["opensession-settings"]);
    await servers["opensession-settings"]?.instance.close();
  });
});
