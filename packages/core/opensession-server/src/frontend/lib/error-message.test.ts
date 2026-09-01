import { describe, expect, test } from "bun:test";
import { errorMessage } from "./error-message";

describe("errorMessage", () => {
  test("returns the message from an Error", () => {
    expect(errorMessage(new Error("Request failed"), "Fallback")).toBe(
      "Request failed",
    );
  });

  test("falls back for non-Error rejection values", () => {
    expect(errorMessage("Request failed", "Fallback")).toBe("Fallback");
    expect(errorMessage({ message: "Request failed" }, "Fallback")).toBe(
      "Fallback",
    );
    expect(errorMessage(null, "Fallback")).toBe("Fallback");
  });

  test("falls back for an Error without a message", () => {
    expect(errorMessage(new Error(), "Fallback")).toBe("Fallback");
  });
});
