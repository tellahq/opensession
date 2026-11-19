import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  fetchGeminiModels,
  geminiCatalogRow,
  geminiPickerModels,
  piKnowsGeminiModel,
} from "./gemini-models";
import { canDiscoverModels, discoverProviderModels } from "./model-discovery";
import { setModelProvider } from "./model-providers";

const chat = ["generateContent", "countTokens"];

describe("Gemini model rows", () => {
  test("maps Google's limits and thinking flag", () => {
    expect(
      geminiCatalogRow({
        name: "models/gemini-4-carbon",
        displayName: "Gemini 4 Carbon",
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 65_536,
        supportedGenerationMethods: chat,
        thinking: true,
      }),
    ).toEqual({
      id: "gemini-4-carbon",
      name: "Gemini 4 Carbon",
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      reasoning: true,
      input: ["text", "image"],
    });
  });

  test("skips models an agent cannot chat with", () => {
    for (const name of [
      "models/text-embedding-004",
      "models/gemini-embedding-001",
      "models/gemini-3.5-flash-preview-tts",
      "models/gemini-3.1-flash-lite-image",
      "models/imagen-4.0-generate-001",
      "models/veo-3.0-generate-001",
    ]) {
      expect(
        geminiCatalogRow({ name, supportedGenerationMethods: chat }),
      ).toBeUndefined();
    }
    expect(
      geminiCatalogRow({
        name: "models/gemini-4-carbon",
        supportedGenerationMethods: ["embedContent"],
      }),
    ).toBeUndefined();
  });
});

describe("fetchGeminiModels", () => {
  test("sends the key as x-goog-api-key and follows pages", async () => {
    const urls: string[] = [];
    const keys: string[] = [];
    const fetchImpl = (async (url: URL, init?: RequestInit) => {
      urls.push(String(url));
      keys.push((init?.headers as Record<string, string>)["x-goog-api-key"]!);
      const page = url.searchParams.get("pageToken");
      return Response.json(
        page
          ? {
              models: [
                {
                  name: "models/gemini-4-hydrogen",
                  supportedGenerationMethods: chat,
                },
              ],
            }
          : {
              models: [
                {
                  name: "models/gemini-4-carbon",
                  supportedGenerationMethods: chat,
                },
                { name: "models/text-embedding-004" },
              ],
              nextPageToken: "p2",
            },
      );
    }) as unknown as typeof fetch;
    const rows = await fetchGeminiModels(
      "AIza-test",
      "https://gemini.test/v1beta/",
      fetchImpl,
    );
    expect(rows.map((r) => r.id)).toEqual([
      "gemini-4-carbon",
      "gemini-4-hydrogen",
    ]);
    expect(urls[0]).toBe("https://gemini.test/v1beta/models?pageSize=1000");
    expect(urls[1]).toContain("pageToken=p2");
    expect(keys).toEqual(["AIza-test", "AIza-test"]);
    expect(urls.join(" ")).not.toContain("AIza-test");
  });

  test("names a rejected key", async () => {
    const fetchImpl = (async () =>
      new Response("{}", { status: 400 })) as unknown as typeof fetch;
    await expect(
      fetchGeminiModels("bad", undefined, fetchImpl),
    ).rejects.toThrow(/rejected the API key/);
  });
});

describe("geminiPickerModels", () => {
  test("keeps the newest few, without aliases, snapshots or shadowed previews", () => {
    expect(
      geminiPickerModels([
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-pro-preview",
        "gemini-4-carbon",
        "gemini-4-carbon-preview",
        "gemini-4-hydrogen",
        "gemini-flash-latest",
        "gemini-2.5-flash-preview-09-2025",
        "gemini-2.0-flash-001",
        "gemma-4-31b-it",
      ]),
    ).toEqual([
      "gemini-4-carbon",
      "gemini-4-hydrogen",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-pro-preview",
      "gemini-2.5-pro",
    ]);
  });
});

describe("Gemini discovery", () => {
  test("needs no base URL for the google provider", () => {
    expect(canDiscoverModels("google", { apiKey: "k" } as never)).toBe(true);
    expect(canDiscoverModels("groq", {})).toBe(false);
    expect(canDiscoverModels("groq", { baseURL: "https://gw.test" })).toBe(
      true,
    );
  });

  test("records only models Pi does not know and fills the picker", async () => {
    expect(piKnowsGeminiModel("gemini-3.5-flash")).toBe(true);
    expect(piKnowsGeminiModel("gemini-4-carbon")).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "os-gemini-discovery-"));
    const path = join(dir, "model-providers.json");
    const prev = process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = path;
    const fetchImpl = (async (url: URL) => {
      expect(String(url)).toStartWith(
        "https://generativelanguage.googleapis.com/v1beta/models",
      );
      return Response.json({
        models: [
          {
            name: "models/gemini-3.5-flash",
            supportedGenerationMethods: chat,
          },
          {
            name: "models/gemini-4-carbon",
            inputTokenLimit: 1_048_576,
            supportedGenerationMethods: chat,
          },
        ],
      });
    }) as unknown as typeof fetch;
    try {
      await setModelProvider("google", { apiKey: "k" });
      const result = await discoverProviderModels("google", fetchImpl);
      expect(result).toEqual({
        models: ["gemini-3.5-flash", "gemini-4-carbon"],
        added: 2,
      });
      const saved = JSON.parse(readFileSync(path, "utf-8"));
      expect(Object.keys(saved.providers.google.discovered.models)).toEqual([
        "gemini-4-carbon",
      ]);
      expect(saved.pickerModels).toEqual([
        "pi/google/gemini-4-carbon",
        "pi/google/gemini-3.5-flash",
      ]);
    } finally {
      if (prev === undefined)
        delete process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
      else process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
