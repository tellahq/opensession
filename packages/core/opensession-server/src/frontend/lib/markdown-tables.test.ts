import { describe, expect, test } from "bun:test";
import {
  classifyColumnValues,
  escapeCsvCell,
  rowsToCsv,
} from "./markdown-tables";

describe("classifyColumnValues", () => {
  test("detects numeric columns with units, percentages, currency, and dashes", () => {
    expect(
      classifyColumnValues([
        { text: "14ms", isSingleCode: false },
        { text: "120ms", isSingleCode: false },
        { text: "—", isSingleCode: false },
        { text: "3.2s", isSingleCode: false },
      ]),
    ).toBe("number");

    expect(
      classifyColumnValues([
        { text: "$1,200.50", isSingleCode: false },
        { text: "$45.00", isSingleCode: false },
      ]),
    ).toBe("number");
  });

  test("detects code/identifier columns and keeps prose columns as text", () => {
    expect(
      classifyColumnValues([
        { text: "pi-runner.ts", isSingleCode: true },
        { text: "pi-guidance.ts", isSingleCode: true },
      ]),
    ).toBe("code");

    expect(
      classifyColumnValues([
        { text: "Handles retries cleanly", isSingleCode: false },
        { text: "Formats diffs", isSingleCode: false },
      ]),
    ).toBe("text");
  });
});

describe("CSV serialization", () => {
  test("quotes commas, quotes, and flattens newlines per RFC 4180", () => {
    expect(escapeCsvCell("plain")).toBe("plain");
    expect(escapeCsvCell('a, "b"')).toBe('"a, ""b"""');
    expect(
      rowsToCsv([
        ["File", "Latency", "Notes"],
        ["a.ts", "12ms", "fast, clean"],
      ]),
    ).toBe('File,Latency,Notes\na.ts,12ms,"fast, clean"');
  });
});
