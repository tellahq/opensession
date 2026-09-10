import { describe, expect, it } from "bun:test";
import githubDark from "@shikijs/themes/github-dark-default";
import githubLight from "@shikijs/themes/github-light-default";
import {
  containerSummary,
  JSON_TREE_COLLAPSE_DEPTH,
  JSON_TREE_MAX_CHARS,
  JSON_TREE_MAX_CHILDREN,
  JSON_TREE_MIN_CHARS,
  JSON_TREE_MIN_LINES,
  type JsonContainer,
  jsonAtPath,
  jsonTreeUpgrader,
  jsonWorthFolding,
  parseJsonPath,
  parseJsonTree,
  renderJsonChildrenHtml,
  renderJsonHeadHtml,
  renderJsonNodeHtml,
  renderJsonTreeHtml,
} from "./json-tree-block";

/** What JSON.stringify can write: the shape a fence's source arrives in. */
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A container node from a JS value, the way the fence arrives. */
function tree(value: JsonValue): JsonContainer {
  const node = parseJsonTree(JSON.stringify(value));
  if (!node) throw new Error("not a container");
  return node;
}

const bigObject = Object.fromEntries(
  Array.from({ length: 40 }, (_, i) => [`key${i}`, i]),
);
const bigSource = JSON.stringify(bigObject, null, 2);

describe("jsonWorthFolding", () => {
  it("folds past the line or character threshold", () => {
    expect(jsonWorthFolding(bigSource)).toBe(true);
    expect(bigSource.split("\n").length).toBeGreaterThan(JSON_TREE_MIN_LINES);
    const minified = JSON.stringify(
      Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`key${i}`, i])),
    );
    expect(minified.split("\n").length).toBe(1);
    expect(minified.length).toBeGreaterThan(JSON_TREE_MIN_CHARS);
    expect(jsonWorthFolding(minified)).toBe(true);
  });

  it("leaves small JSON as highlighted code", () => {
    expect(jsonWorthFolding('{\n  "a": 1\n}')).toBe(false);
    const thirtyLines = `[\n${Array.from({ length: 27 }, () => "  1,").join("\n")}\n  1\n]`;
    expect(thirtyLines.split("\n").length).toBe(JSON_TREE_MIN_LINES);
    expect(jsonWorthFolding(thirtyLines)).toBe(false);
    expect(jsonWorthFolding(`${thirtyLines}\n`)).toBe(false);
  });

  it("gives up on a document too big to build rows for", () => {
    expect(jsonWorthFolding("x".repeat(JSON_TREE_MAX_CHARS + 1))).toBe(false);
  });
});

describe("parseJsonTree", () => {
  it("returns an object or array root as a tagged tree", () => {
    expect(parseJsonTree('{"a":[1, "s", true, null]}')).toEqual({
      kind: "object",
      entries: [
        [
          "a",
          {
            kind: "array",
            items: [
              { kind: "number", value: 1 },
              { kind: "string", value: "s" },
              { kind: "boolean", value: true },
              { kind: "null" },
            ],
          },
        ],
      ],
    });
    expect(parseJsonTree("[]")).toEqual({ kind: "array", items: [] });
  });

  it("keeps the document's key order", () => {
    const node = tree({ z: 1, a: 2, m: 3 });
    expect(node.kind === "object" && node.entries.map(([k]) => k)).toEqual([
      "z",
      "a",
      "m",
    ]);
  });

  it("declines scalars, streaming and invalid JSON", () => {
    expect(parseJsonTree('"text"')).toBeNull();
    expect(parseJsonTree("42")).toBeNull();
    expect(parseJsonTree("null")).toBeNull();
    expect(parseJsonTree('{"a": [1, 2')).toBeNull();
    expect(parseJsonTree('{"a": 1,}')).toBeNull();
    expect(parseJsonTree("// c\n{}")).toBeNull();
  });
});

describe("jsonAtPath and parseJsonPath", () => {
  const root = tree({ a: [{ b: null }, 2], "x y": { c: false }, "0": "zero" });

  it("walks keys and indices by the node it is on", () => {
    expect(jsonAtPath(root, [])).toBe(root);
    expect(jsonAtPath(root, ["a", "0", "b"])).toEqual({ kind: "null" });
    expect(jsonAtPath(root, ["a", "1"])).toEqual({ kind: "number", value: 2 });
    expect(jsonAtPath(root, ["x y", "c"])).toEqual({
      kind: "boolean",
      value: false,
    });
    expect(jsonAtPath(root, ["0"])).toEqual({ kind: "string", value: "zero" });
  });

  it("returns undefined off the path rather than reading the prototype", () => {
    expect(jsonAtPath(root, ["a", "x"])).toBeUndefined();
    expect(jsonAtPath(root, ["nope"])).toBeUndefined();
    expect(jsonAtPath(root, ["constructor"])).toBeUndefined();
    expect(jsonAtPath(root, ["a", "1", "x"])).toBeUndefined();
  });

  it("round-trips a node's data-path", () => {
    expect(parseJsonPath(JSON.stringify(["a", "0", "b"]))).toEqual([
      "a",
      "0",
      "b",
    ]);
    expect(parseJsonPath(undefined)).toBeNull();
    expect(parseJsonPath("{")).toBeNull();
    expect(parseJsonPath("[0]")).toBeNull();
  });
});

describe("renderJsonTreeHtml", () => {
  it("renders typed leaves with their keys", () => {
    const html = renderJsonTreeHtml(
      tree({ name: "x", n: 1.5, ok: true, none: null, "a key": 1 }),
    );
    expect(html).toContain(
      '<span class="md-json-key">name</span><span class="md-json-punct">: </span><span class="md-json-string">&quot;x&quot;</span>',
    );
    expect(html).toContain('<span class="md-json-number">1.5</span>');
    expect(html).toContain('<span class="md-json-keyword">true</span>');
    expect(html).toContain('<span class="md-json-keyword">null</span>');
    expect(html).toContain(
      '<span class="md-json-key">&quot;a key&quot;</span>',
    );
  });

  it("opens the root and its children and folds deeper containers", () => {
    const html = renderJsonTreeHtml(tree({ a: { b: { c: 1 } } }));
    const opens = [...html.matchAll(/data-open="(true|false)"/g)].map(
      (m) => m[1],
    );
    expect(opens).toEqual(["true", "true", "false"]);
    expect(JSON_TREE_COLLAPSE_DEPTH).toBe(2);
    // A folded node carries its path and no rows yet; its children come on
    // the first expand.
    expect(html).toContain(
      'data-lazy data-path="[&quot;a&quot;,&quot;b&quot;]"',
    );
    expect(html).not.toContain('<span class="md-json-key">c</span>');
    expect(html).toContain('aria-expanded="false" aria-label="Expand"');
    expect(html).toContain('aria-expanded="true" aria-label="Collapse"');
  });

  it("renders a folded node's children on demand at the right depth", () => {
    const root = tree({ a: { b: { c: { d: 1 } } } });
    const b = jsonAtPath(root, ["a", "b"]);
    if (!b || b.kind !== "object") throw new Error("expected b");
    const html = renderJsonChildrenHtml(b, ["a", "b"], 2);
    expect(html).toContain('data-open="false"');
    expect(html).toContain(
      'data-path="[&quot;a&quot;,&quot;b&quot;,&quot;c&quot;]"',
    );
  });

  it("summarises a container by count and shows empties inline", () => {
    expect(containerSummary(tree({}))).toBe("0 keys");
    expect(containerSummary(tree({ a: 1 }))).toBe("1 key");
    expect(containerSummary(tree([1, 2, 3]))).toBe("3 items");
    const html = renderJsonTreeHtml(tree({ list: [1], empty: [], none: {} }));
    expect(html).toContain('<span class="md-json-count">1 item</span>');
    expect(html).toContain('<span class="md-json-punct">[]</span>');
    expect(html).toContain('<span class="md-json-punct">{}</span>');
    expect(html.match(/md-json-caret/g)?.length).toBe(2);
  });

  it("indexes array rows and closes with the matching bracket", () => {
    const html = renderJsonNodeHtml(tree([1]), null, [], 0);
    expect(html).toContain('<span class="md-json-index">0</span>');
    expect(html).toContain(
      '<div class="md-json-end"><span class="md-json-punct">]</span></div>',
    );
  });

  it("escapes keys and strings as text", () => {
    const html = renderJsonTreeHtml(tree({ "<b>": '<img src=x onerror="1">' }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain(
      "&quot;&lt;img src=x onerror=\\&quot;1\\&quot;&gt;&quot;",
    );
  });

  it("caps the rows of a huge container and says so", () => {
    const html = renderJsonChildrenHtml(
      tree(Array.from({ length: JSON_TREE_MAX_CHILDREN + 3 }, (_, i) => i)),
      [],
      0,
    );
    expect(html.match(/<li /g)?.length).toBe(JSON_TREE_MAX_CHILDREN + 1);
    expect(html).toContain("3 more in the raw view");
  });

  it("writes the header with the tree view pressed", () => {
    const html = renderJsonHeadHtml(tree({ a: 1, b: 2 }));
    expect(html).toContain('data-view="tree" aria-pressed="true">Tree<');
    expect(html).toContain('data-view="raw" aria-pressed="false">Raw<');
    expect(html).toContain('<span class="md-json-summary">2 keys</span>');
  });
});

describe("registration", () => {
  it("claims json and keeps the copy control", () => {
    expect(jsonTreeUpgrader.langs).toEqual(["json"]);
    expect(jsonTreeUpgrader.keepsCodeControls).toBe(true);
  });
});

describe("json-tree.css", () => {
  const css = Bun.file(
    new URL("../styles/blocks/json-tree.css", import.meta.url),
  ).text();

  function token(sheet: string, scope: string, name: string): string {
    const block =
      scope === "light"
        ? /html\[data-theme="light"\] \{([^}]*)\}/.exec(sheet)?.[1]
        : /:root \{([^}]*)\}/.exec(sheet)?.[1];
    return (
      new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(block ?? "")?.[1] ?? ""
    );
  }

  function shikiInk(theme: typeof githubDark, scope: string): string {
    for (const rule of theme.tokenColors ?? []) {
      const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
      if (scopes.includes(scope) && rule.settings.foreground)
        return rule.settings.foreground.toLowerCase();
    }
    throw new Error(`no ${scope} in ${theme.name}`);
  }

  it("inks the tree with shiki's JSON colours in both themes", async () => {
    const sheet = await css;
    for (const [scope, theme] of [
      ["dark", githubDark],
      ["light", githubLight],
    ] as const) {
      expect(token(sheet, scope, "json-key")).toBe(
        shikiInk(theme, "support.type.property-name.json"),
      );
      expect(token(sheet, scope, "json-string")).toBe(
        shikiInk(theme, "string"),
      );
      expect(token(sheet, scope, "json-constant")).toBe(
        shikiInk(theme, "constant"),
      );
    }
  });
});
