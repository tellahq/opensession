import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { toolInputDiff } from "./tool-input-diff";

function parsed(toolName: string, input: unknown) {
  const value = toolInputDiff(toolName, input);
  expect(value).not.toBeNull();
  return {
    value: value!,
    file: parsePatchFiles(value!.patch)[0].files[0],
  };
}

describe("code-writing tool diffs", () => {
  test("renders a multi-edit schema as highlighted replacement hunks", () => {
    const { value, file } = parsed("Edit", {
      path: "src/example.ts",
      edits: [
        { oldText: "const before = 1;", newText: "const after = 2;" },
        { oldText: "run(before);", newText: "run(after);\nreport(after);" },
      ],
    });

    expect(value.path).toBe("src/example.ts");
    expect(file.name).toBe("src/example.ts");
    expect(file.deletionLines).toEqual([
      "const before = 1;\n",
      "run(before);\n",
    ]);
    expect(file.additionLines).toEqual([
      "const after = 2;\n",
      "run(after);\n",
      "report(after);",
    ]);
  });

  test("renders a whole-file write as additions", () => {
    const { file } = parsed("Write", {
      file_path: "src/new.tsx",
      content: "export function New() {\n  return <div />;\n}",
    });

    expect(file.type).toBe("new");
    expect(file.additionLines).toEqual([
      "export function New() {\n",
      "  return <div />;\n",
      "}",
    ]);
    expect(file.deletionLines).toEqual([]);
  });

  test("supports snake-case and camel-case replacement keys", () => {
    const snake = parsed("edit", {
      file_path: "a.css",
      old_string: "color: red;",
      new_string: "color: green;",
    }).file;
    const camel = parsed("Edit", {
      filePath: "b.css",
      oldString: "color: red;",
      newString: "color: green;",
    }).file;

    expect(snake.deletionLines).toEqual(["color: red;\n"]);
    expect(camel.additionLines).toEqual(["color: green;"]);
  });

  test("leaves apply_patch input to the existing diff fallback", () => {
    expect(
      toolInputDiff("apply_patch", {
        patch:
          "*** Begin Patch\n*** Update File: src/a.ts\n-old\n+new\n*** End Patch",
      }),
    ).toBeNull();
  });
});
