import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detachLocalFolder,
  localFolderOp,
  localFolderWsClose,
  localFolderWsMessage,
  localFoldersContextNote,
  resetLocalFoldersForTest,
  sessionLocalFolders,
} from "./local-folders";
import {
  applyExactEdits,
  createLocalFoldersMcpServer,
  folderPath,
} from "./local-folders-mcp";
import type { WSClientData } from "./ws-hub";

type Sent = { type: string; [key: string]: unknown };

/** A bridge socket whose device answers from an in-memory file map. */
function fakeDevice(
  owner: string,
  files: Map<string, string>,
  options: { silent?: boolean } = {},
) {
  const sent: Sent[] = [];
  const socket = {
    data: {
      watchingSessionId: null,
      user: null,
      authUser: owner,
    } as WSClientData,
    send(raw: string) {
      const message = JSON.parse(raw) as Sent;
      sent.push(message);
      if (message.type !== "local_folder_op" || options.silent) return;
      const args = message.args as Record<string, unknown>;
      const path = String(args.path ?? "");
      const reply = (body: object) =>
        queueMicrotask(() =>
          localFolderWsMessage(socket, {
            type: "local_folder_result",
            requestId: message.requestId,
            ...body,
          }),
        );
      if (message.op === "stat") {
        const content = files.get(path);
        return content === undefined
          ? reply({ ok: false, error: `${path} does not exist` })
          : reply({
              ok: true,
              result: { kind: "file", size: content.length, mtimeMs: 1 },
            });
      }
      if (message.op === "read") {
        const content = files.get(path) ?? "";
        const offset = Number(args.offset);
        const chunk = content.slice(offset, offset + Number(args.length));
        return reply({
          ok: true,
          result: {
            data: Buffer.from(chunk).toString("base64"),
            size: content.length,
            mtimeMs: 1,
          },
        });
      }
      if (message.op === "write") {
        const data = Buffer.from(String(args.data), "base64").toString();
        files.set(path, (args.append ? (files.get(path) ?? "") : "") + data);
        return reply({ ok: true, result: { ok: true } });
      }
      reply({ ok: false, error: "unsupported" });
    },
  };
  return { socket, sent };
}

function hello(
  socket: ReturnType<typeof fakeDevice>["socket"],
  folders: object[],
) {
  return localFolderWsMessage(socket, {
    type: "local_folders_hello",
    deviceId: "mac-1",
    deviceLabel: "Acme MacBook",
    folders,
  });
}

async function callTool(
  server: ReturnType<typeof createLocalFoldersMcpServer>,
  name: string,
  args: Record<string, unknown>,
) {
  const tools = (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: unknown, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools;
  const result = (await tools[name]!.handler(args, {})) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: result.content[0]!.text, isError: !!result.isError };
}

afterEach(() => resetLocalFoldersForTest());

describe("local folders", () => {
  test("a device announces folders per session and goes offline on close", () => {
    const { socket, sent } = fakeDevice("Alice", new Map());
    expect(
      hello(socket, [
        {
          id: "f1",
          name: "Taxes",
          displayPath: "~/Documents/Taxes",
          sessionIds: ["s1", "../bad"],
        },
        { id: "bad id!", name: "x", sessionIds: ["s1"] },
      ]),
    ).toBe(true);
    expect(socket.data.presenceSuppressed).toBe(true);
    expect(sent.at(-1)?.type).toBe("local_folders_ready");
    expect(sessionLocalFolders("s1")).toEqual([
      {
        key: "mac-1:f1",
        id: "f1",
        name: "Taxes",
        displayPath: "~/Documents/Taxes",
        readOnly: false,
        deviceId: "mac-1",
        deviceLabel: "Acme MacBook",
        owner: "Alice",
        online: true,
      },
    ]);
    expect(sessionLocalFolders("s2")).toEqual([]);
    localFolderWsClose(socket);
    expect(sessionLocalFolders("s1")[0]?.online).toBe(false);
  });

  test("automation sockets cannot become bridges", () => {
    const { socket } = fakeDevice("Alice", new Map());
    socket.data.authAutomation = true;
    hello(socket, [{ id: "f1", name: "Taxes", sessionIds: ["s1"] }]);
    expect(sessionLocalFolders("s1")).toEqual([]);
  });

  test("only the owner's turns reach the folder, and offline fails fast", async () => {
    const { socket } = fakeDevice("Alice", new Map([["a.txt", "hi"]]));
    hello(socket, [{ id: "f1", name: "Taxes", sessionIds: ["s1"] }]);
    await expect(
      localFolderOp("s1", "Bob", undefined, "stat", { path: "a.txt" }),
    ).rejects.toThrow("Only the person who connected");
    await expect(
      localFolderOp("s1", "alice", undefined, "stat", { path: "a.txt" }),
    ).resolves.toMatchObject({ kind: "file", size: 2 });
    localFolderWsClose(socket);
    await expect(
      localFolderOp("s1", "Alice", undefined, "stat", { path: "a.txt" }),
    ).rejects.toThrow("offline");
  });

  test("read-only folders refuse writes before reaching the device", async () => {
    const { socket, sent } = fakeDevice("Alice", new Map());
    hello(socket, [
      { id: "f1", name: "Taxes", readOnly: true, sessionIds: ["s1"] },
    ]);
    const before = sent.length;
    await expect(
      localFolderOp("s1", "Alice", "Taxes", "write", { path: "a", data: "" }),
    ).rejects.toThrow("read-only");
    expect(sent.length).toBe(before);
  });

  test("a closed socket rejects its pending operations, and a silent one times out", async () => {
    const quiet = fakeDevice("Alice", new Map(), { silent: true });
    hello(quiet.socket, [{ id: "f1", name: "Taxes", sessionIds: ["s1"] }]);
    const pending = localFolderOp("s1", "Alice", undefined, "stat", {
      path: "a",
    });
    localFolderWsClose(quiet.socket);
    await expect(pending).rejects.toThrow("disconnected");
    const again = fakeDevice("Alice", new Map(), { silent: true });
    hello(again.socket, [{ id: "f1", name: "Taxes", sessionIds: ["s1"] }]);
    await expect(
      localFolderOp(
        "s1",
        "Alice",
        undefined,
        "stat",
        { path: "a" },
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow("did not answer");
  });

  test("detach is owner-only, tells the device, and drops the offline view", () => {
    const { socket, sent } = fakeDevice("Alice", new Map());
    hello(socket, [{ id: "f1", name: "Taxes", sessionIds: ["s1", "s2"] }]);
    expect(detachLocalFolder("s1", "mac-1:f1", "Bob")).toBe(false);
    expect(detachLocalFolder("s1", "mac-1:f1", "Alice")).toBe(true);
    expect(sent.at(-1)).toMatchObject({
      type: "local_folder_detach",
      sessionId: "s1",
      folderId: "f1",
    });
    expect(sessionLocalFolders("s1")).toEqual([]);
    expect(sessionLocalFolders("s2")).toHaveLength(1);
  });

  test("a folder dropped from a later hello does not linger as offline", () => {
    const { socket } = fakeDevice("Alice", new Map());
    hello(socket, [{ id: "f1", name: "Taxes", sessionIds: ["s1"] }]);
    hello(socket, [{ id: "f1", name: "Taxes", sessionIds: [] }]);
    expect(sessionLocalFolders("s1")).toEqual([]);
  });

  test("a folder announced for a session id before it exists is ready for its first turn", () => {
    const { socket } = fakeDevice("Alice", new Map());
    hello(socket, [{ id: "f1", name: "Taxes", sessionIds: ["s-new"] }]);
    expect(localFoldersContextNote("s-new", "Alice")).toContain("Taxes");
  });

  test("the prompt note names only the prompter's folders", () => {
    const { socket } = fakeDevice("Alice", new Map());
    hello(socket, [
      {
        id: "f1",
        name: "Taxes",
        displayPath: "~/Taxes",
        readOnly: true,
        sessionIds: ["s1"],
      },
    ]);
    expect(localFoldersContextNote("s1", "Bob")).toBeNull();
    const note = localFoldersContextNote("s1", "Alice")!;
    expect(note).toContain(
      "Taxes (~/Taxes) on Acme MacBook: read-only, online",
    );
    expect(note).toContain("local_read");
  });
});

describe("local folder tools", () => {
  let scratch: string;
  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  test("paths stay relative and edits must match exactly once", () => {
    expect(folderPath("./a//b/")).toBe("a/b");
    expect(() => folderPath("../x")).toThrow();
    expect(() => folderPath("/etc")).toThrow();
    expect(
      applyExactEdits("one two three", [
        { oldText: "three", newText: "3" },
        { oldText: "one", newText: "1" },
      ]),
    ).toBe("1 two 3");
    expect(() =>
      applyExactEdits("a a", [{ oldText: "a", newText: "b" }]),
    ).toThrow("more than once");
    expect(() =>
      applyExactEdits("abc", [
        { oldText: "ab", newText: "x" },
        { oldText: "bc", newText: "y" },
      ]),
    ).toThrow("overlap");
  });

  test("read, edit, and copy round trip through the device", async () => {
    scratch = await mkdtemp(join(tmpdir(), "os-local-folders-"));
    const files = new Map([["notes/todo.md", "one\ntwo\nthree\n"]]);
    const { socket } = fakeDevice("Alice", files);
    hello(socket, [{ id: "f1", name: "Taxes", sessionIds: ["s1"] }]);
    const server = createLocalFoldersMcpServer({
      sessionId: "s1",
      user: "Alice",
      workspace: () => ({
        scratchDir: join(scratch, "scratch"),
        roots: [scratch],
      }),
    });
    expect(
      (
        await callTool(server, "local_read", {
          path: "notes/todo.md",
          offset: 2,
          limit: 1,
        })
      ).text,
    ).toBe("two\n\n[Lines 2-2 of 4. Use offset to read more.]");
    expect(
      (
        await callTool(server, "local_edit", {
          path: "notes/todo.md",
          edits: [{ oldText: "two", newText: "2" }],
        })
      ).isError,
    ).toBe(false);
    expect(files.get("notes/todo.md")).toBe("one\n2\nthree\n");
    const copied = await callTool(server, "copy_from_local_folder", {
      path: "notes/todo.md",
    });
    const local = copied.text.split(" to ")[1]!;
    expect(await readFile(local, "utf8")).toBe("one\n2\nthree\n");
    await writeFile(join(scratch, "report.txt"), "done");
    expect(
      (
        await callTool(server, "copy_to_local_folder", {
          source: "report.txt",
          path: "out/report.txt",
        })
      ).isError,
    ).toBe(false);
    expect(files.get("out/report.txt")).toBe("done");
    const escape = await callTool(server, "copy_to_local_folder", {
      source: "/etc/hostname",
      path: "x",
    });
    expect(escape.isError).toBe(true);
    const other = createLocalFoldersMcpServer({
      sessionId: "s1",
      user: "Bob",
      workspace: () => null,
    });
    expect(
      (await callTool(other, "local_read", { path: "notes/todo.md" })).text,
    ).toContain("Only the person who connected");
  });
});
