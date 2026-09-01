import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeFlow } from "./CodeFlow";

describe("CodeFlow", () => {
  test("groups changed trees under one file header", () => {
    const html = renderToStaticMarkup(
      <CodeFlow
        loading={false}
        error={null}
        onRetry={() => {}}
        data={{
          repo: "opensession",
          base: "abc",
          head: "def",
          diffVersion: "1-abc",
          languages: ["ReScript", "Rust", "TSX"],
          skippedFiles: 0,
          trees: [
            {
              entry: "Profile",
              tree: {
                key: "Profile",
                label: "Profile({ user })",
                kind: "call",
                status: "same",
                file: "src/Profile.tsx",
                line: 10,
                children: [
                  {
                    key: "ProfileLayout",
                    label: "ProfileLayout()",
                    kind: "call",
                    status: "added",
                    file: "src/Profile.tsx",
                    line: 14,
                    children: [],
                  },
                ],
              },
            },
            {
              entry: "ProfileMenu",
              tree: {
                key: "ProfileMenu",
                label: "ProfileMenu()",
                kind: "call",
                status: "added",
                file: "src/Profile.tsx",
                line: 22,
                children: [],
              },
            },
          ],
        }}
      />,
    );
    expect(html).toContain("Code flow");
    expect(html).toContain("ReScript · Rust · TSX");
    expect(html).toContain("ProfileLayout()");
    expect(html).toContain("ProfileMenu()");
    expect(html).toContain("2 changed flows");
    expect(html).toContain("src/Profile.tsx");
    expect(html.match(/src\/Profile\.tsx/g)).toHaveLength(1);
    expect(html).not.toContain("Powered by");
  });

  test("has a focused empty state", () => {
    const html = renderToStaticMarkup(
      <CodeFlow
        loading={false}
        error={null}
        onRetry={() => {}}
        data={{
          repo: "opensession",
          base: "abc",
          head: "def",
          diffVersion: "1-abc",
          languages: ["Rust"],
          skippedFiles: 0,
          trees: [],
        }}
      />,
    );
    expect(html).toContain("No code-flow changes detected");
  });

  test("does not claim an empty result when analysis was bounded", () => {
    const html = renderToStaticMarkup(
      <CodeFlow
        loading={false}
        error={null}
        onRetry={() => {}}
        data={{
          repo: "opensession",
          base: "abc",
          head: "def",
          diffVersion: "v1",
          languages: ["TypeScript"],
          skippedFiles: 1,
          truncated: true,
          trees: [],
        }}
      />,
    );
    expect(html).toContain("Code flow was limited");
    expect(html).not.toContain("No code-flow changes detected");
  });

  test("treats skipped files as a partial result", () => {
    const html = renderToStaticMarkup(
      <CodeFlow
        loading={false}
        error={null}
        onRetry={() => {}}
        data={{
          repo: "opensession",
          base: "abc",
          head: "def",
          diffVersion: "v2",
          languages: [],
          skippedFiles: 2,
          trees: [],
        }}
      />,
    );
    expect(html).toContain("Code flow was limited");
    expect(html).toContain("2 changed files could not be analyzed");
    expect(html).not.toContain("No code-flow changes detected");
  });

  test("groups a cross-file tree under its changed location", () => {
    const html = renderToStaticMarkup(
      <CodeFlow
        loading={false}
        error={null}
        onRetry={() => {}}
        data={{
          repo: "opensession",
          base: "abc",
          head: "def",
          diffVersion: "v3",
          languages: ["TypeScript"],
          skippedFiles: 0,
          trees: [
            {
              entry: "caller",
              tree: {
                key: "caller",
                label: "caller()",
                kind: "call",
                status: "same",
                file: "src/unchanged.ts",
                children: [
                  {
                    key: "changed",
                    label: "changed()",
                    kind: "call",
                    status: "added",
                    file: "src/changed.ts",
                    children: [],
                  },
                ],
              },
            },
          ],
        }}
      />,
    );
    expect(html).toContain("src/changed.ts");
    expect(html).not.toContain(">src/unchanged.ts<");
  });
});
