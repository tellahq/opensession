const { expect, test } = require("bun:test");
const {
  requestMenuTemplate,
  showKeychainRequestMenu,
} = require("./mac-keychain-menu");

test("request details are noninteractive and complete even for long URLs and Unicode", () => {
  const detail = `Keychain service: Example API\n\nGET https://api.example.test/${"a".repeat(170)}😀`;
  const selected = [];
  const template = requestMenuTemplate({ detail }, (value) =>
    selected.push(value),
  );
  const labels = template
    .filter((item) => item.enabled === false)
    .map((item) => item.label);
  expect(labels.every((line) => Array.from(line).length <= 66)).toBe(true);
  expect(labels.map((line) => line.replace(/^  /, "")).join("")).toBe(
    detail.replace(/\n/g, ""),
  );
  expect(selected).toEqual([]);
  template.find((item) => item.label === "Use once…").click();
  expect(selected).toEqual([1]);
});

test("native menu dismissal cancels; only the explicit Use once action continues", async () => {
  for (const action of [undefined, "Cancel", "Use once…"]) {
    const target = {};
    const result = await showKeychainRequestMenu(
      target,
      { detail: "Example request" },
      {
        Menu: {
          buildFromTemplate: (template) => ({
            popup: (options) => {
              expect(options.window).toBe(target);
              if (action)
                template.find((item) => item.label === action).click();
              options.callback();
            },
          }),
        },
      },
    );
    expect(result).toEqual({ response: action === "Use once…" ? 1 : 0 });
  }
});
