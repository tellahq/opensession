import { expect, test } from "bun:test";

test("the optimistic phone header uses the repo before a worktree exists", async () => {
  const source = await Bun.file(
    new URL("../SessionViewer.tsx", import.meta.url),
  ).text();

  expect(source).toContain(
    "(session.archived || session.desk || session.repo || hasWorkspace)",
  );
});

test("the optimistic phone header names the model before its catalog loads", async () => {
  const viewer = await Bun.file(
    new URL("../SessionViewer.tsx", import.meta.url),
  ).text();
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
