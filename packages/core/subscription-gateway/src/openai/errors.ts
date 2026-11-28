export interface OpenAIErrorEnvelope {
  readonly error: {
    readonly message: string;
    readonly type: "invalid_request_error" | "server_error";
    readonly param: string | null;
    readonly code: string | null;
  };
}

export class OpenAIRequestError extends Error {
  readonly param: string | null;
  readonly code: string;

  constructor(message: string, options?: { param?: string; code?: string }) {
    super(message);
    this.name = "OpenAIRequestError";
    this.param = options?.param ?? null;
    this.code = options?.code ?? "invalid_request";
  }

  toEnvelope(): OpenAIErrorEnvelope {
    return {
      error: {
        message: this.message,
        type: "invalid_request_error",
        param: this.param,
        code: this.code,
      },
    };
  }
}

export function serverErrorEnvelope(message: string): OpenAIErrorEnvelope {
  return {
    error: {
      message,
      type: "server_error",
      param: null,
      code: null,
    },
  };
}
