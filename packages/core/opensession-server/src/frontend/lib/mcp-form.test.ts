import { describe, expect, test } from "bun:test";
import { parseMcpEnvironment } from "./mcp-form";

describe("parseMcpEnvironment", () => {
  test("parses values after the first separator", () => {
    expect(
      parseMcpEnvironment("TOKEN=secret\nURL=https://x.test?a=b\n"),
    ).toEqual({
      TOKEN: "secret",
      URL: "https://x.test?a=b",
    });
  });

  test("ignores blank lines and rejects malformed entries", () => {
    expect(parseMcpEnvironment("\n KEY = value \n")).toEqual({ KEY: "value" });
    expect(() => parseMcpEnvironment("TOKEN")).toThrow(
      'Env line "TOKEN" must be KEY=VALUE',
    );
  });
});
