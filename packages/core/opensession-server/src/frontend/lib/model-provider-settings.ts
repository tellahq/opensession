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

  const payload: ModelProviderSettingsPayload = { discoverModels };
  if (cleanApiKey) payload.apiKey = cleanApiKey;
  if (cleanBaseURL) payload.baseURL = cleanBaseURL;
  if (models.length) payload.models = models;
  if (custom) payload.api = "openai-completions";
  if (cleanName) payload.name = cleanName;
  return payload;
}
