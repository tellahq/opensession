import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const base = mkdtempSync(join(tmpdir(), "claude-token-login-"));
process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = join(base, "accounts.json");

const {
  cancelClaudeTokenLogin,
  getClaudeTokenLogin,
  readableTerminalText,
  setupTokenIn,
  signInUrlIn,
  startClaudeTokenLogin,
  submitClaudeTokenLoginCode,
} = await import("./claude-token-login");

const TOKEN = `sk-ant-oat01-${"Ab1_-".repeat(19)}`;
const URL_LINE =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&scope=user%3Ainference&state=xyz";

// Stands in for `claude setup-token`: a terminal interface that prints the
// sign-in link, waits for a pasted code, then prints the token. It draws
// nothing without a terminal, like the real one.
const fake = join(base, "claude");
writeFileSync(
  fake,
  `#!${process.execPath}
import { appendFileSync } from "fs";
if (!process.stdout.isTTY) process.exit(0);
appendFileSync(${JSON.stringify(join(base, "calls.jsonl"))}, JSON.stringify({ args: process.argv.slice(2), config: process.env.CLAUDE_CONFIG_DIR, cols: process.stdout.columns }) + "\\n");
const mode = process.env.HOME.endsWith("-quits") ? "quits" : "works";
// Like the real one, it reads keys raw before it draws anything.
process.stdin.setRawMode(true);
process.stdout.write("\\x1b[2J\\x1b[1mWelcome to Claude Code\\x1b[0m\\r\\n\\x1b]0;claude\\x07");
process.stdout.write("\\x1b[36mBrowser didn't open? Use the url below to sign in\\x1b[0m\\r\\n${URL_LINE}\\r\\n");
if (mode === "quits") { process.stdout.write("Something broke\\r\\n"); process.exit(1); }
let typed = "";
process.stdin.on("data", (chunk) => {
  typed += chunk.toString();
  if (!typed.includes("\\r")) return;
  if (typed.trim() !== "good#code") { process.stdout.write("\\r\\n\\x1b[31mOAuth error: That code wasn't accepted.\\x1b[0m\\r\\nPress Enter to retry.\\r\\n"); typed = ""; return; }
  process.stdout.write("\\r\\n\\x1b[32m✓ Long-lived authentication token created successfully!\\x1b[0m\\r\\n\\r\\nYour OAuth token (valid for 1 year):\\r\\n\\r\\n\\x1b[33m${TOKEN}\\x1b[0m\\r\\n\\r\\nStore this token securely.\\r\\n");
  setTimeout(() => process.exit(0), 50);
});
process.stdout.write("Paste code here if prompted > ");
`,
);
chmodSync(fake, 0o755);

const realHome = process.env.HOME;
const added: { name: string; token: string; owner?: string }[] = [];
const add = (async (name: string, token: string, owner?: string) => {
  added.push({ name, token, owner });
  return { id: "acct-1", name } as never;
}) as never;

async function until<T>(read: () => T | undefined | false, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out");
}

beforeAll(() => {
  process.env.HOME = join(base, "home");
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(base, { recursive: true, force: true });
});

describe("reading what claude setup-token shows", () => {
  test("drops colors, cursor moves and titles", () => {
    expect(
      readableTerminalText("\x1b[2J\x1b[1mHi\x1b[0m\r\x1b]0;title\x07there"),
    ).toBe("Hi\nthere");
  });

  test("finds the sign-in link, only on Anthropic's own sites", () => {
    expect(signInUrlIn(`sign in\n${URL_LINE}\nPaste code`)).toBe(URL_LINE);
    expect(
      signInUrlIn("https://example.test/oauth/authorize?code=true"),
    ).toBeUndefined();
    expect(signInUrlIn("nothing yet")).toBeUndefined();
  });

  test("finds the token", () => {
    expect(setupTokenIn(`Your OAuth token:\n\n${TOKEN}\n\nStore it`)).toBe(
      TOKEN,
    );
    expect(setupTokenIn("sk-ant-oat01-short")).toBeUndefined();
  });
});

describe("signing in with Claude", () => {
  setDefaultTimeout(30_000);

  test("shows the link, takes the code, and adds the account", async () => {
    const started = await startClaudeTokenLogin(" ada@example.test ", "ada", {
      executable: fake,
      add,
    });
    if (!("id" in started)) throw new Error(started.error);
    const waiting = await until(() => {
      const login = getClaudeTokenLogin(started.id);
      return login?.state === "awaiting_sign_in" && login;
    });
    expect(waiting.url).toBe(URL_LINE);

    // A second click joins the attempt under way.
    const again = await startClaudeTokenLogin("ada@example.test", undefined, {
      executable: fake,
      add,
    });
    expect("id" in again && again.id).toBe(started.id);

    expect(submitClaudeTokenLoginCode(started.id, "  ")).toEqual({
      error: "code is required",
    });
    submitClaudeTokenLoginCode(started.id, " good#code\n");
    const done = await until(() => {
      const login = getClaudeTokenLogin(started.id);
      return login?.state !== "awaiting_sign_in" && login;
    });
    expect(done.state).toBe("done");
    expect(done.account as unknown).toEqual({
      id: "acct-1",
      name: "ada@example.test",
    });
    expect(added).toEqual([
      { name: "ada@example.test", token: TOKEN, owner: "ada" },
    ]);
    // The token is never part of what a caller can read.
    expect(JSON.stringify(done)).not.toContain("sk-ant");
    expect(submitClaudeTokenLoginCode(started.id, "x")).toEqual({
      error: "This sign-in is no longer waiting for a code.",
    });
  });

  test("reports a sign-in the command gave up on", async () => {
    process.env.HOME = join(base, "home-quits");
    const started = await startClaudeTokenLogin("grace@example.test", "", {
      executable: fake,
      add,
    });
    process.env.HOME = join(base, "home");
    if (!("id" in started)) throw new Error(started.error);
    const failed = await until(() => {
      const login = getClaudeTokenLogin(started.id);
      return login?.state === "error" && login;
    });
    expect(failed.error).toContain(
      "Sign-in did not complete (claude exited 1)",
    );
    expect(failed.error).toContain("Something broke");
    expect(added).toHaveLength(1);
  });

  test("reports a code Claude refused", async () => {
    const started = await startClaudeTokenLogin("joan@example.test", "", {
      executable: fake,
      add,
    });
    if (!("id" in started)) throw new Error(started.error);
    await until(
      () => getClaudeTokenLogin(started.id)?.state === "awaiting_sign_in",
    );
    submitClaudeTokenLoginCode(started.id, "wrong#code");
    const failed = await until(() => {
      const login = getClaudeTokenLogin(started.id);
      return login?.state === "error" && login;
    });
    expect(failed.error).toBe("That code wasn't accepted.");
    expect(added).toHaveLength(1);
  });

  test("can be cancelled, and says so when Claude Code is missing", async () => {
    const started = await startClaudeTokenLogin("lin@example.test", "", {
      executable: fake,
      add,
    });
    if (!("id" in started)) throw new Error(started.error);
    expect(cancelClaudeTokenLogin(started.id)).toBe(true);
    expect(getClaudeTokenLogin(started.id)?.state).toBe("cancelled");
    expect(cancelClaudeTokenLogin("unknown")).toBe(false);

    const missing = await startClaudeTokenLogin("kay@example.test", "", {
      executable: join(base, "no-such-claude"),
      add,
    });
    expect("id" in missing && missing.state).toBe("error");
    expect("error" in missing && missing.error).toMatch(
      /not installed|Could not start/,
    );
    expect(await startClaudeTokenLogin("  ", "", { add })).toEqual({
      error: "Name is required",
    });
  });
});
