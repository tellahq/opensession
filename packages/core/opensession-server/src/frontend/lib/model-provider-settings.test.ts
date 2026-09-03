import { describe, expect, test } from "bun:test";
import { modelProviderSettingsPayload } from "./model-provider-settings";

describe("model provider settings payload", () => {
  test("omits the protocol when the custom gateway option is unchanged", () => {
    expect(
      modelProviderSettingsPayload({
        apiKey: " new-key\n",
        baseURL: "",
        models: [],
        custom: false,
        name: "",
        discoverModels: false,
      }),
    ).toEqual({
      apiKey: "new-key",
      discoverModels: false,
    });
  });

  test("declares the protocol for an OpenAI-compatible gateway", () => {
    expect(
      modelProviderSettingsPayload({
        apiKey: "key",
        baseURL: " https://gateway.test/v1 ",
        models: ["model-a"],
        custom: true,
        name: " Gateway ",
        discoverModels: true,
      }),
    ).toEqual({
      apiKey: "key",
      baseURL: "https://gateway.test/v1",
      models: ["model-a"],
      api: "openai-completions",
      name: "Gateway",
      discoverModels: true,
    });
  });
});
