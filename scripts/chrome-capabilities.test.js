import { expect, test } from "bun:test";
import { supportsCapability } from "../packages/clients/chrome/capabilities.js";

test("Chrome uses only explicitly advertised capabilities", () => {
  for (const descriptor of [null, {}, { capabilities: {} }]) {
    expect(supportsCapability(descriptor, "sessionCreateIdempotency")).toBe(
      false,
    );
  }
  for (const flag of [false, 0, -1, 1.5, "true", {}, null]) {
    expect(
      supportsCapability(
        { capabilities: { sessionListSlices: flag } },
        "sessionListSlices",
      ),
    ).toBe(false);
  }
  for (const flag of [true, 1, 2]) {
    expect(
      supportsCapability(
        { capabilities: { sessionListSlices: flag, futureKey: {} } },
        "sessionListSlices",
      ),
    ).toBe(true);
  }
});
