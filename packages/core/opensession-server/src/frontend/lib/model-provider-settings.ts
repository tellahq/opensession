export interface ModelProviderSettingsInput {
  apiKey: string;
  baseURL: string;
  models: string[];
  custom: boolean;
  name: string;
  discoverModels: boolean;
}

interface ModelProviderSettingsPayload {
  apiKey?: string;
  baseURL?: string;
  models?: string[];
  api?: "openai-completions";
  name?: string;
  discoverModels: boolean;
}

export function modelProviderSettingsPayload({
  apiKey,
  baseURL,
  models,
  custom,
  name,
  discoverModels,
}: ModelProviderSettingsInput): ModelProviderSettingsPayload {
  const cleanApiKey = apiKey.replace(/\s+/g, "");
  const cleanBaseURL = baseURL.trim();
  const cleanName = name.trim();

  return {
    ...(cleanApiKey ? { apiKey: cleanApiKey } : {}),
    ...(cleanBaseURL ? { baseURL: cleanBaseURL } : {}),
    ...(models.length ? { models } : {}),
    ...(custom ? { api: "openai-completions" } : {}),
    ...(cleanName ? { name: cleanName } : {}),
    discoverModels,
  };
}
