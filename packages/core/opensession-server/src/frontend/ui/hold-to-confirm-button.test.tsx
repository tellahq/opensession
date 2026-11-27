import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HoldToConfirmButton } from "./hold-to-confirm-button";

describe("HoldToConfirmButton", () => {
  test("renders idle label and busy state cleanly", () => {
    const idle = renderToStaticMarkup(
      <HoldToConfirmButton
        label="Hold to merge anyway"
        busyLabel="Merging…"
        onConfirm={() => {}}
      />,
    );
    expect(idle).toContain("Hold to merge anyway");
    expect(idle).toContain("scaleX(0)");

    const busy = renderToStaticMarkup(
      <HoldToConfirmButton
        label="Hold to merge anyway"
        busyLabel="Merging…"
        busy
        onConfirm={() => {}}
      />,
    );
    expect(busy).toContain("Merging…");
    expect(busy).toContain("disabled");
  });
});
