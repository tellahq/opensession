import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * In-harness secret redaction and invisible-tag sanitization for tool outputs.
 *
 * Scans tool result text blocks (and thrown tool errors) before they enter the
 * model's context, replacing high-signal credential formats with typed
 * `[REDACTED:<type>]` placeholders and stripping invisible Unicode tag
 * characters (U+E0000..U+E007F). Image content blocks are untouched.
 */

export interface SecretPattern {
  readonly id: string;
  /** Case-insensitive literal triggers; at least one must appear in the input
   *  before the regex runs. Keeps megabyte build-log scans near-zero cost. */
  readonly triggers: readonly string[];
  readonly regex: RegExp;
  /** Optional validator receiving the matched secret token. */
  readonly validate?: (secret: string) => boolean;
  /** Optional custom replacer when only a subgroup (e.g. URL password) should
   *  be replaced. Defaults to replacing the full match with `[REDACTED:<id>]`. */
  readonly replace?: (match: string, ...groups: string[]) => string;
}

const INVISIBLE_UNICODE_TAGS = /[\u{E0000}-\u{E007F}]/gu;

const PLACEHOLDER_RE =
  /^(?:your[_-]?|example|dummy|fake|test|sample|placeholder|changeme|password|secret|token|redacted|xxx+|<[^>]+>|\$\{[^}]+\}|\$[A-Z0-9_]+|\[REDACTED:[^\]]+\])/i;

function looksLikePlaceholder(value: string): boolean {
  if (PLACEHOLDER_RE.test(value)) return true;
  if (/^(.)\1{7,}$/.test(value)) return true;
  return false;
}

function isLikelyJwt(token: string): boolean {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  try {
    const headerJson = Buffer.from(
      token.slice(0, dot).replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
    const parsed = JSON.parse(headerJson) as Record<string, unknown>;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.alg === "string"
    );
  } catch {
    return false;
  }
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: "aws-access-key",
    triggers: ["akia", "asia", "abia", "acca"],
    regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "github-token",
    triggers: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"],
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g,
  },
  {
    id: "anthropic-key",
    triggers: ["sk-ant-"],
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "openai-key",
    triggers: ["sk-proj-", "sk-svcacct-", "sk-admin-", "sk-"],
    regex:
      /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}|[A-Za-z0-9]{48,})\b/g,
  },
  {
    id: "stripe-key",
    triggers: ["sk_live_", "rk_live_", "whsec_"],
    regex: /\b(?:[rs]k_live_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{24,})\b/g,
  },
  {
    id: "slack-token",
    triggers: ["xox"],
    regex: /\bxox(?:[abposr]|e\.xox[bp])-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "google-api-key",
    triggers: ["aiza"],
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "npm-token",
    triggers: ["npm_"],
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "pypi-token",
    triggers: ["pypi-age"],
    regex: /\bpypi-AgE[A-Za-z0-9_-]{50,}\b/g,
  },
  {
    id: "linear-key",
    triggers: ["lin_api_"],
    regex: /\blin_api_[A-Za-z0-9]{32,}\b/g,
  },
  {
    id: "sendgrid-key",
    triggers: ["sg."],
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
  },
  {
    id: "jwt",
    triggers: ["eyj"],
    regex:
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/g,
    validate: isLikelyJwt,
  },
  {
    id: "url-credential",
    triggers: ["://"],
    regex:
      /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:)(?!\[REDACTED:)([^\s/@"']{8,})(@[^\s/"']+)/gi,
    replace: (match, prefix, secret, suffix) => {
      if (!secret || looksLikePlaceholder(secret)) return match;
      return `${prefix}[REDACTED:url-credential]${suffix}`;
    },
  },
  {
    id: "bearer-token",
    triggers: ["bearer "],
    regex:
      /(\bAuthorization\s*:\s*Bearer\s+)(?!\[REDACTED:)([A-Za-z0-9._~+/=-]{24,})/gi,
    replace: (match, prefix, secret) => {
      if (!secret || looksLikePlaceholder(secret)) return match;
      return `${prefix}[REDACTED:bearer-token]`;
    },
  },
];

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_BODY_LINE_RE = /^(\s*)([A-Za-z0-9+/=]{16,})(\s*)$/;

function redactPemPrivateKeys(text: string): {
  text: string;
  redacted: boolean;
} {
  if (!text.includes("-----BEGIN") || !text.includes("PRIVATE KEY-----")) {
    return { text, redacted: false };
  }
  const lines = text.split("\n");
  let insideKey = false;
  let redacted = false;
  const out = lines.map((line) => {
    if (!insideKey) {
      if (PEM_BEGIN_RE.test(line) && !PEM_END_RE.test(line)) {
        insideKey = true;
      }
      return line;
    }
    if (PEM_END_RE.test(line)) {
      insideKey = false;
      return line;
    }
    const m = PEM_BODY_LINE_RE.exec(line);
    if (!m) {
      if (line.trim().length === 0 || line.includes(":")) return line;
      insideKey = false;
      return line;
    }
    redacted = true;
    return `${m[1]}[REDACTED:private-key]${m[3]}`;
  });
  return redacted
    ? { text: out.join("\n"), redacted: true }
    : { text, redacted: false };
}

export function isSecretRedactionDisabled(): boolean {
  const raw = process.env.OPENSESSION_DISABLE_SECRET_REDACTION;
  return raw === "1" || raw === "true";
}

export interface RedactTextResult {
  readonly text: string;
  readonly redactedTypes: readonly string[];
  readonly strippedInvisibleTags: number;
}

export function redactSecretsInText(
  input: string,
  opts?: { readonly allowDisable?: boolean },
): RedactTextResult {
  if (!input)
    return { text: input, redactedTypes: [], strippedInvisibleTags: 0 };

  let text = input;
  const withoutTags = text.replace(INVISIBLE_UNICODE_TAGS, "");
  const strippedInvisibleTags = text.length - withoutTags.length;
  text = withoutTags;

  if ((opts?.allowDisable ?? true) && isSecretRedactionDisabled()) {
    return { text, redactedTypes: [], strippedInvisibleTags };
  }

  const lower = text.toLowerCase();
  const redactedTypes = new Set<string>();

  for (const spec of SECRET_PATTERNS) {
    if (!spec.triggers.some((t) => lower.includes(t))) continue;
    spec.regex.lastIndex = 0;
    const replaced = text.replace(spec.regex, (match, ...args) => {
      if (spec.replace) {
        const next = spec.replace(match, ...(args as string[]));
        if (next !== match) redactedTypes.add(spec.id);
        return next;
      }
      if (looksLikePlaceholder(match)) return match;
      if (spec.validate && !spec.validate(match)) return match;
      redactedTypes.add(spec.id);
      return `[REDACTED:${spec.id}]`;
    });
    text = replaced;
  }

  const pem = redactPemPrivateKeys(text);
  if (pem.redacted) {
    text = pem.text;
    redactedTypes.add("private-key");
  }

  return {
    text,
    redactedTypes: [...redactedTypes],
    strippedInvisibleTags,
  };
}

export function containsRedactedPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return value.includes("[REDACTED:");
  if (Array.isArray(value)) return value.some(containsRedactedPlaceholder);
  if (value && typeof value === "object") {
    return Object.values(value).some(containsRedactedPlaceholder);
  }
  return false;
}

const EDIT_TOOL_NAMES = new Set(["edit", "apply_patch"]);

const REDACTED_EDIT_HINT =
  "Note: your edit input contains a [REDACTED:<type>] placeholder from secret redaction. Because the original secret text was redacted from tool output, ask the user to manually edit lines containing secrets instead of guessing or overwriting them.";

function redactToolResult<TResult>(result: TResult): TResult {
  if (!result || typeof result !== "object") return result;
  const record = result as { content?: unknown };
  if (!Array.isArray(record.content)) return result;

  let changed = false;
  const nextContent = record.content.map((item) => {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      const original = (item as { text: string }).text;
      const { text } = redactSecretsInText(original);
      if (text !== original) {
        changed = true;
        return { ...item, text };
      }
    }
    return item;
  });

  if (!changed) return result;
  return { ...result, content: nextContent };
}

/**
 * Wrap Pi custom tools so every text result (and thrown error message) has
 * high-signal credentials replaced with `[REDACTED:<type>]` before entering
 * the model's context. When an edit fails on input containing a redaction
 * placeholder, appends actionable guidance.
 */
export function piSecretRedactionTools(
  tools: readonly ToolDefinition<any, any, any>[],
): ToolDefinition<any, any, any>[] {
  return tools.map((tool) => ({
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const result = await tool.execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          ctx,
        );
        return redactToolResult(result);
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        const { text: redactedMessage } = redactSecretsInText(rawMessage);
        const addHint =
          EDIT_TOOL_NAMES.has(tool.name) &&
          containsRedactedPlaceholder(params) &&
          !redactedMessage.includes(REDACTED_EDIT_HINT);
        const finalMessage = addHint
          ? `${redactedMessage}\n\n${REDACTED_EDIT_HINT}`
          : redactedMessage;
        if (finalMessage !== rawMessage) {
          const next = new Error(finalMessage);
          if (err instanceof Error && err.stack) next.stack = err.stack;
          throw next;
        }
        throw err;
      }
    },
  }));
}
