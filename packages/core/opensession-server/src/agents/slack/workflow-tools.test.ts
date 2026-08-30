import { describe, expect, test } from "bun:test";
import { selectableModels } from "../../server/models";
import {
  RUN_WORKFLOW_DESCRIPTION,
  WORKFLOW_DEFAULT_MODEL,
  workflowCapabilitiesText,
} from "./workflow-tools";

describe("workflow authoring discovery", () => {
  test("keeps the always-loaded run description compact", () => {
    expect(RUN_WORKFLOW_DESCRIPTION.length).toBeLessThan(1_600);
    expect(RUN_WORKFLOW_DESCRIPTION).toContain("/workflow-authoring");
    expect(RUN_WORKFLOW_DESCRIPTION).toContain("workflow_capabilities");
    expect(RUN_WORKFLOW_DESCRIPTION).not.toContain(WORKFLOW_DEFAULT_MODEL);
  });

  test("loads current models and limits only on demand", () => {
    const capabilities = workflowCapabilitiesText();
    expect(capabilities).toContain(
      `Default agent model: ${WORKFLOW_DEFAULT_MODEL}`,
    );
    for (const model of selectableModels()) {
      expect(capabilities).toContain(`${model.id} — ${model.label}`);
    }
    expect(capabilities).toContain("Runtime limits:");
  });
});
