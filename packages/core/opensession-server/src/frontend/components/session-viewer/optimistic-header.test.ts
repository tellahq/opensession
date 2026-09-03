import { expect, test } from "bun:test";

test("the optimistic phone header uses the repo before a worktree exists", async () => {
  const source = await Promise.all([
    Bun.file(new URL("../SessionViewer.tsx", import.meta.url)).text(),
    Bun.file(new URL("./SessionViewerChrome.tsx", import.meta.url)).text(),
  ]).then((parts) => parts.join("\n"));

  expect(source).toContain(
    "(session.archived || session.desk || session.repo || hasWorkspace)",
  );
});

test("the optimistic phone header names the model before its catalog loads", async () => {
  const viewer = await Promise.all([
    Bun.file(new URL("../SessionViewer.tsx", import.meta.url)).text(),
    Bun.file(new URL("./SessionViewerChrome.tsx", import.meta.url)).text(),
  ]).then((parts) => parts.join("\n"));
  const create = await Bun.file(
    new URL("../NewSession.tsx", import.meta.url),
  ).text();

  expect(viewer).toContain(
    "(hasWorkspace || effectiveModel || models.length > 0)",
  );
  expect(viewer).toContain("{effectiveModel && (");
  expect(create).toContain("const optimisticModel = model || defaultModel;");
  expect(create).toContain(
    "...(optimisticModel ? { model: optimisticModel } : {})",
  );
});
