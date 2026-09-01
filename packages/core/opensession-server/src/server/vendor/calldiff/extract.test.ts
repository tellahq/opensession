import { describe, expect, test } from "bun:test";
import { buildChangedTrees } from "./core";
import { buildFunctionIndex } from "./extract";

function changed(path: string, before: string, after: string) {
  return buildChangedTrees(
    buildFunctionIndex([{ path, content: before }]),
    buildFunctionIndex([{ path, content: after }]),
  ).trees;
}

function labels(value: unknown): string {
  return JSON.stringify(value);
}

describe("vendored calldiff extractors", () => {
  test("diffs React component trees and hook callback bodies", () => {
    const trees = changed(
      "Profile.tsx",
      `export function Profile({ user }: { user: User }) {
			  useEffect(() => trackOld(user), [user.id]);
			  return <Card><Avatar /></Card>;
			}`,
      `export function Profile({ user }: { user: User }) {
			  useEffect(() => trackNew(user), [user]);
			  return <ProfileLayout><Avatar /><FollowButton /></ProfileLayout>;
			}`,
    );
    expect(trees).toHaveLength(1);
    const text = labels(trees);
    expect(text).toContain("useEffect([user.id])");
    expect(text).toContain("useEffect([user])");
    expect(text).toContain("trackNew");
    expect(text).toContain("ProfileLayout");
    expect(text).toContain("FollowButton");
  });

  test("marks a changed TypeScript signature", () => {
    const trees = changed(
      "run.ts",
      "export function run(value: string) { return save(value); }",
      "export function run(value: string, force: boolean) { return save(value); }",
    );
    expect(trees[0]?.tree.status).toBe("modified");
    expect(trees[0]?.tree.label).toContain("force");
  });

  test("detects type-only TypeScript signature changes", () => {
    const trees = changed(
      "run.ts",
      "export function run(value: string): string { return value; }",
      "export function run(value: number): number { return value; }",
    );
    expect(trees[0]?.tree.status).toBe("modified");
    expect(trees[0]?.tree.label).toContain("value: number");
  });

  test("keeps duplicate short function names from different files", () => {
    const before = buildFunctionIndex([
      { path: "a.ts", content: "export function run() { return oldA(); }" },
      { path: "b.ts", content: "export function run() { return oldB(); }" },
    ]);
    const after = buildFunctionIndex([
      { path: "a.ts", content: "export function run() { return newA(); }" },
      { path: "b.ts", content: "export function run() { return newB(); }" },
    ]);
    const trees = buildChangedTrees(before, after).trees;
    expect(trees).toHaveLength(2);
    expect(trees.map((tree) => tree.entry).sort()).toEqual([
      "a.ts::run",
      "b.ts::run",
    ]);
  });

  test("resolves Rust trait and typed parameter method calls", () => {
    const trees = changed(
      "src/lib.rs",
      `trait Store { fn save(&self); }
			struct Db {}
			impl Store for Db { fn save(&self) { old_write(); } }
			pub fn run(store: &Store) { store.save(); }`,
      `trait Store { fn save(&self); }
			struct Db {}
			impl Store for Db { fn save(&self) { new_write(); } }
			pub fn run(store: &Store) { store.save(); }`,
    );
    const text = labels(trees);
    expect(text).toContain("Store.save");
    expect(text).toContain("new_write");
  });

  test("extracts functions nested in Rust modules", () => {
    const index = buildFunctionIndex([
      {
        path: "src/lib.rs",
        content: "mod inner { pub fn run() { save(); } }",
      },
    ]);
    expect([...index.keys()]).toContain("src/lib.rs::inner::run");
  });

  test("diffs ReScript functions, modules, and JSX components", () => {
    const trees = changed(
      "Profile.res",
      `module Data = {
			  let load = id => fetchOld(id)
			}
			@react.component
			let make = (~id) => {
			  let user = Data.load(id)
			  <Card><Avatar /></Card>
			}`,
      `module Data = {
			  let load = id => fetchNew(id)
			}
			@react.component
			let make = (~id) => {
			  let user = Data.load(id)
			  <ProfileLayout><Avatar /><FollowButton /></ProfileLayout>
			}`,
    );
    const text = labels(trees);
    expect(text).toContain("Data.load");
    expect(text).toContain("fetchNew");
    expect(text).toContain("ProfileLayout");
    expect(text).toContain("FollowButton");
  });

  test("keeps adjacent expression-bodied ReScript functions separate", () => {
    const index = buildFunctionIndex([
      {
        path: "Math.res",
        content:
          "let one = x => first(x)\nlet two = x => second(x)\nlet three = x => third(x)",
      },
    ]);
    expect([...index.keys()]).toEqual([
      "Math.res::one",
      "Math.res::two",
      "Math.res::three",
    ]);
    expect(labels(index.get("Math.res::one"))).not.toContain("second");
  });

  test("ignores multiline ReScript template contents and preserves later lines", () => {
    const index = buildFunctionIndex([
      {
        path: "Template.res",
        content:
          "let run = () => {\n  let value = j`first(\nsecond())`\n  save(value)\n}",
      },
    ]);
    const info = index.get("Template.res::run");
    expect(labels(info)).not.toContain("second");
    expect(
      info?.steps.find((step) => step.type === "call" && step.key === "save")
        ?.line,
    ).toBe(4);
  });

  test("caps complete TypeScript signature labels", () => {
    const params = Array.from(
      { length: 30 },
      (_, index) => `value${index}: VeryLongTypeName${index}`,
    ).join(", ");
    const index = buildFunctionIndex([
      {
        path: "large.ts",
        content: `export function run(${params}) { return save(); }`,
      },
    ]);
    expect(index.get("large.ts::run")?.label.length).toBeLessThanOrEqual(183);
  });
});
