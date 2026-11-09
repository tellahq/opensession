import { describe, expect, test } from "bun:test";
import { formatWebSearch, parseWebSearchResponse } from "./web-search";

describe("parseWebSearchResponse", () => {
  test("keeps hits in rank order, dedupes by URL, and joins commentary", () => {
    const outcome = parseWebSearchResponse(
      {
        query: "acme release notes",
        results: [
          {
            tool_use_id: "srvtoolu_1",
            content: [
              { title: "Acme 2.0", url: "https://acme.example.test/2.0" },
              { title: "", url: "https://docs.example.test/acme" },
              { title: "Duplicate", url: "https://acme.example.test/2.0" },
              { title: "No URL" },
            ],
          },
          "Acme 2.0 shipped in May.",
          {
            tool_use_id: "srvtoolu_2",
            content: [{ title: "Blog", url: "https://blog.example.test" }],
          },
          "  ",
        ],
        durationSeconds: 3,
      },
      "fallback",
    );
    expect(outcome).toEqual({
      query: "acme release notes",
      hits: [
        { title: "Acme 2.0", url: "https://acme.example.test/2.0" },
        {
          title: "https://docs.example.test/acme",
          url: "https://docs.example.test/acme",
        },
        { title: "Blog", url: "https://blog.example.test" },
      ],
      summary: "Acme 2.0 shipped in May.",
    });
  });

  test("tolerates a malformed response", () => {
    expect(parseWebSearchResponse(undefined, "q")).toEqual({
      query: "q",
      hits: [],
      summary: "",
    });
    expect(parseWebSearchResponse({ results: "nope" }, "q").hits).toEqual([]);
  });
});

describe("formatWebSearch", () => {
  test("numbers hits and labels the summary as unverified", () => {
    const text = formatWebSearch({
      query: "acme",
      hits: [{ title: "Acme", url: "https://acme.example.test" }],
      summary: "Acme is a company.",
    });
    expect(text).toContain('Web search: "acme" (1 result)');
    expect(text).toContain("1. Acme\n   https://acme.example.test");
    expect(text).toContain("unverified");
    expect(text).toContain("fetch_url");
  });

  test("says when nothing was found", () => {
    const text = formatWebSearch({ query: "zzz", hits: [], summary: "" });
    expect(text).toContain("(0 results)");
    expect(text).toContain("No results.");
    expect(text).not.toContain("Summary");
  });
});
