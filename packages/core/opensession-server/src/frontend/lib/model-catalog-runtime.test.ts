import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  engineCapabilitiesSchema,
  modelSupportsSteering,
} from "./model-catalog-runtime";

const capabilities = {
  version: 1,
  supportsSteering: false,
  supportsInterrupt: true,
  canResume: true,
  canRewindConversation: false,
  canForkNatively: false,
  supportsMcpTools: true,
  supportsImages: false,
  streamsReasoning: true,
  emitsToolOutput: true,
  terminalStatusQuality: "authoritative",
} as const;

test("Effect decodes versioned wire capabilities", async () => {
  expect(
    await Effect.runPromise(
      Schema.decodeUnknownEffect(engineCapabilitiesSchema)(capabilities),
    ),
  ).toEqual(capabilities);
  await expect(
    Effect.runPromise(
      Schema.decodeUnknownEffect(engineCapabilitiesSchema)({
        ...capabilities,
        version: 99,
      }),
    ),
  ).rejects.toThrow();
});

test("declared steering capabilities override busy-send preferences", () => {
  expect(
    modelSupportsSteering(
      [{ id: "acp/example", engineCapabilities: { supportsSteering: false } }],
      "acp/example",
    ),
  ).toBe(false);
  expect(
    modelSupportsSteering(
      [{ id: "pi/example", engineCapabilities: { supportsSteering: true } }],
      "pi/example",
    ),
  ).toBe(true);
  expect(modelSupportsSteering([], "legacy-model")).toBe(true);
});
