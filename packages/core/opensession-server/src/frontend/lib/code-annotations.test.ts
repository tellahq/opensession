import { describe, expect, test } from "bun:test";
import { extractLineAnnotation } from "./code-annotations";

describe("extractLineAnnotation", () => {
  test("extracts //, #, --, and /* */ @note directives cleanly", () => {
    expect(
      extractLineAnnotation("const x = 1; // @note: locks the write queue"),
    ).toEqual({
      code: "const x = 1;",
      note: "locks the write queue",
    });
    expect(
      extractLineAnnotation("retry = 3  # @note: exponential backoff"),
    ).toEqual({
      code: "retry = 3",
      note: "exponential backoff",
    });
    expect(extractLineAnnotation("SELECT 1; -- @note: health probe")).toEqual({
      code: "SELECT 1;",
      note: "health probe",
    });
    expect(
      extractLineAnnotation("width: 100%; /* @note: fills container */"),
    ).toEqual({
      code: "width: 100%;",
      note: "fills container",
    });
  });

  test("leaves ordinary comments and code untouched", () => {
    expect(extractLineAnnotation("const x = 1; // normal comment")).toEqual({
      code: "const x = 1; // normal comment",
      note: null,
    });
  });
});
