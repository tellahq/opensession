import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchSelect } from "./combobox";
import { OptionSelect } from "./select";

const channels = [
  { value: "C1", label: "#engineering" },
  { value: "C2", label: "#proj-search" },
];

describe("SearchSelect", () => {
  test("closes to the same field-shaped trigger as a select", () => {
    const searchable = renderToStaticMarkup(
      <SearchSelect
        label="Slack channel"
        value="C2"
        options={channels}
        onChange={() => {}}
        className="w-32"
      />,
    );
    const plain = renderToStaticMarkup(
      <OptionSelect
        label="Slack channel"
        value="C2"
        options={channels}
        onChange={() => {}}
        className="w-32"
      />,
    );
    // The closed control reads its label from the items, like a select.
    expect(searchable).toContain("#proj-search");
    expect(searchable).toContain('aria-label="Slack channel"');
    expect(searchable).toContain("aria-haspopup=");
    // Same box: a row can swap one for the other without the row changing.
    const box = /class="([^"]*rounded-control[^"]*)"/;
    expect(searchable.match(box)?.[1]).toBe(plain.match(box)?.[1]);
  });

  test("shows the placeholder until something is picked", () => {
    const html = renderToStaticMarkup(
      <SearchSelect
        label="Slack channel"
        value=""
        options={[]}
        onChange={() => {}}
        placeholder="No channels"
        disabled
      />,
    );
    expect(html).toContain("No channels");
    expect(html).toContain("disabled");
  });
});
