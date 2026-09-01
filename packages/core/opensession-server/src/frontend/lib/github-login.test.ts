import { describe, expect, test } from "bun:test";
import { githubLoginFromInput } from "./github-login";

describe("githubLoginFromInput", () => {
  test.each([
    ["monalisa", "monalisa"],
    ["@monalisa", "monalisa"],
    ["https://github.com/monalisa", "monalisa"],
    ["https://www.github.com/monalisa/", "monalisa"],
    ["github.com/monalisa?tab=repositories", "monalisa"],
  ])("reads %s", (input, expected) => {
    expect(githubLoginFromInput(input)).toBe(expected);
  });

  test.each([
    "",
    "-monalisa",
    "monalisa-",
    "https://example.com/monalisa",
    "https://github.com/owner/repository",
    "github.com/",
  ])("rejects %s", (input) => {
    expect(githubLoginFromInput(input)).toBeNull();
  });
});
