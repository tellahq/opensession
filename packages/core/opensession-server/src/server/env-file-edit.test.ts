import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyEnvEdits,
  applyEnvFileEdits,
  envFilePath,
  prepareEnvFileEdits,
  readEnvFileValues,
  validateEnvValue,
  WEB_SETUP_MARKER,
  WEB_SETUP_UNSET_SUFFIX,
} from "./env-file-edit";

const savedEnvFile = process.env.OPENSESSION_ENV_FILE;
let root = "";
let file = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "os-env-edit-"));
  file = join(root, "opensession.env");
  process.env.OPENSESSION_ENV_FILE = file;
});

afterEach(() => {
  if (savedEnvFile === undefined) delete process.env.OPENSESSION_ENV_FILE;
  else process.env.OPENSESSION_ENV_FILE = savedEnvFile;
  rmSync(root, { recursive: true, force: true });
});

describe("applyEnvEdits", () => {
  test("replaces an existing KEY=... line in place", () => {
    const before = "A=1\nSLACK_BOT_TOKEN=old\nB=2\n";
    const after = applyEnvEdits(before, {
      SLACK_BOT_TOKEN: "replacement-token",
    });
    expect(after).toBe("A=1\nSLACK_BOT_TOKEN=replacement-token\nB=2\n");
  });

  test("uncomments a commented # KEY=... line in place", () => {
    const before = "A=1\n# SLACK_BOT_TOKEN=old\nB=2\n";
    const after = applyEnvEdits(before, {
      SLACK_BOT_TOKEN: "replacement-token",
    });
    expect(after).toBe("A=1\nSLACK_BOT_TOKEN=replacement-token\nB=2\n");
  });

  test("prefers the active line over a commented one", () => {
    const before = "# SLACK_BOT_TOKEN=commented\nSLACK_BOT_TOKEN=active\n";
    const after = applyEnvEdits(before, { SLACK_BOT_TOKEN: "new" });
    expect(after).toBe("# SLACK_BOT_TOKEN=commented\nSLACK_BOT_TOKEN=new\n");
  });

  test("appends new keys at the end under the web-setup marker", () => {
    const after = applyEnvEdits("A=1\n", { NEW_KEY: "v1", OTHER_KEY: "v2" });
    expect(after).toBe(
      `A=1\n\n${WEB_SETUP_MARKER}\nNEW_KEY=v1\nOTHER_KEY=v2\n`,
    );
  });

  test("reuses an existing marker instead of adding another", () => {
    const before = `A=1\n\n${WEB_SETUP_MARKER}\nNEW_KEY=v1\n`;
    const after = applyEnvEdits(before, { OTHER_KEY: "v2" });
    expect(
      after.split("\n").filter((l) => l === WEB_SETUP_MARKER),
    ).toHaveLength(1);
    expect(after).toContain("OTHER_KEY=v2");
  });

  test("empty value comments the active line out (unset)", () => {
    const before = "A=1\nSLACK_BOT_TOKEN=secret\nB=2\n";
    const after = applyEnvEdits(before, { SLACK_BOT_TOKEN: "" });
    expect(after).toBe(
      `A=1\n# SLACK_BOT_TOKEN=secret${WEB_SETUP_UNSET_SUFFIX}\nB=2\n`,
    );
  });

  test("unsetting an absent key is a no-op", () => {
    expect(applyEnvEdits("A=1\n", { MISSING: "" })).toBe("A=1\n");
  });

  test("does not touch keys that merely share a prefix", () => {
    const before = "SLACK_BOT_TOKEN_BACKUP=keep\nSLACK_BOT_TOKEN=old\n";
    const after = applyEnvEdits(before, { SLACK_BOT_TOKEN: "new" });
    expect(after).toBe("SLACK_BOT_TOKEN_BACKUP=keep\nSLACK_BOT_TOKEN=new\n");
  });

  test("handles export-prefixed lines", () => {
    const after = applyEnvEdits("export API_KEY=old\n", { API_KEY: "new" });
    expect(after).toBe("API_KEY=new\n");
  });

  test("quotes values with spaces or shell-meaningful characters", () => {
    const after = applyEnvEdits("", { KEY: 'a value with "quotes" and #hash' });
    expect(after).toContain('KEY="a value with \\"quotes\\" and #hash"');
  });

  test("starts an empty file with the marker", () => {
    expect(applyEnvEdits("", { KEY: "v" })).toBe(
      `${WEB_SETUP_MARKER}\nKEY=v\n`,
    );
  });
});

describe("applyEnvFileEdits (disk)", () => {
  test("writes .bak-<n> backups, keeps 0600, and round-trips values", () => {
    writeFileSync(file, "EXISTING=1\n");
    applyEnvFileEdits({ NEW_KEY: "hello world" });
    expect(existsSync(`${file}.bak-1`)).toBe(true);
    expect(readFileSync(`${file}.bak-1`, "utf-8")).toBe("EXISTING=1\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    applyEnvFileEdits({ NEW_KEY: "second" });
    expect(existsSync(`${file}.bak-2`)).toBe(true);

    const values = readEnvFileValues();
    expect(values.EXISTING).toBe("1");
    expect(values.NEW_KEY).toBe("second");
  });

  test("creates the file when absent (no backup) and unquotes on read", () => {
    applyEnvFileEdits({ KEY: 'with "quotes"' });
    expect(existsSync(`${file}.bak-1`)).toBe(false);
    expect(readEnvFileValues().KEY).toBe('with "quotes"');
  });

  test("commented-out keys disappear unless unset values are requested", () => {
    writeFileSync(file, "KEY=live\n");
    applyEnvFileEdits({ KEY: "" });
    expect(readEnvFileValues().KEY).toBeUndefined();
    expect(readEnvFileValues({ includeUnset: true }).KEY).toBe("");
  });

  test("ordinary commented examples are not treated as pending clears", () => {
    writeFileSync(file, "# KEY=example\n");
    expect(readEnvFileValues({ includeUnset: true }).KEY).toBeUndefined();
  });

  test("prepared edits can roll back after a later config write fails", () => {
    writeFileSync(file, "KEY=before\n");
    const edit = prepareEnvFileEdits({ KEY: "after" });

    edit.commit();
    expect(readFileSync(file, "utf-8")).toBe("KEY=after\n");
    edit.rollback();

    expect(readFileSync(file, "utf-8")).toBe("KEY=before\n");
  });

  test("envFilePath honors the OPENSESSION_ENV_FILE override", () => {
    expect(envFilePath()).toBe(file);
  });
});

describe("validateEnvValue", () => {
  test("accepts ordinary single-line strings", () => {
    expect(validateEnvValue("test-token-value")).toBeNull();
    expect(validateEnvValue("")).toBeNull();
  });

  test("rejects non-strings", () => {
    expect(validateEnvValue(42)).not.toBeNull();
    expect(validateEnvValue(null)).not.toBeNull();
    expect(validateEnvValue(undefined)).not.toBeNull();
  });

  test("rejects newlines, carriage returns and NUL", () => {
    expect(validateEnvValue("a\nb")).not.toBeNull();
    expect(validateEnvValue("a\rb")).not.toBeNull();
    expect(validateEnvValue("a\0b")).not.toBeNull();
  });

  test("rejects values over 4096 chars", () => {
    expect(validateEnvValue("x".repeat(4096))).toBeNull();
    expect(validateEnvValue("x".repeat(4097))).not.toBeNull();
  });
});
