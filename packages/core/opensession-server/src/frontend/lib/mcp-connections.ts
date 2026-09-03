export interface McpConnection {
  name: string;
  transport: "http" | "stdio";
  target: string;
  envKeys: string[];
  status:
    | "connected"
    | "ready"
    | "needs-env"
    | "needs-auth"
    | "unreachable"
    | "missing";
  detail?: string;
  /** Per-user allowlist, if this server is restricted (absent = everyone). */
  allowedUsers?: string[];
}

const TOKEN_CONNECT_URL_VALUES = {
  vercel: {
    url: "https://vercel.com/account/settings/tokens",
    label: "vercel.com/account/settings/tokens",
  },
  vero: {
    url: "https://help.getvero.com/vero-ai/mcp-authentication",
    label: "Vero's MCP authentication guide",
  },
} satisfies Readonly<Record<string, { url: string; label: string }>>;

export const TOKEN_CONNECT_URLS = Object.fromEntries(
  Object.entries(TOKEN_CONNECT_URL_VALUES),
);
