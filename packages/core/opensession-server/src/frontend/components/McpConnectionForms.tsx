import { useEffect, useState } from "react";
import { displayName } from "../brand-logos";
import { request } from "../lib/api/request";
import { errorMessage } from "../lib/error-message";
import { parseMcpEnvironment } from "../lib/mcp-form";
import { TOKEN_CONNECT_URLS, type McpConnection } from "../lib/mcp-connections";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Modal } from "../ui/modal";
import { OptionSelect } from "../ui/select";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { InlineAlert } from "../ui/state";
import {
  SettingsField,
  SettingsForm,
  SettingsFormActions,
  SettingsFormRow,
  SettingsFormTitle,
  settingsInputClass,
} from "../ui/settings";

/**
 * Paste-a-token connect for providers whose hosted MCP gates OAuth client
 * registration (Vercel approves only clients it has reviewed). Any teammate
 * can mint a personal token; the server validates it live against the
 * provider's API before storing it as a grant.
 */
export function ConnectTokenDialog({
  server,
  onClose,
  onConnected,
}: {
  server: McpConnection | null;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [scope, setScope] = useState<"shared" | "me">("shared");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (server) {
      setScope("shared");
      setToken("");
      setError(null);
    }
  }, [server]);
  if (!server) return null;
  const active = server;
  const tokenPage = TOKEN_CONNECT_URLS[active.name];

  async function connect() {
    if (!token.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await request(
        `/connections/mcp/${encodeURIComponent(active.name)}/token`,
        {
          method: "POST",
          body: { token: token.trim(), scope },
          label: `Could not connect ${active.name}`,
        },
      );
      onConnected();
    } catch (cause) {
      setError(errorMessage(cause, `Could not connect ${active.name}`));
    }
    setSaving(false);
  }

  return (
    <Modal.Root
      open={!!server}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <Modal.Content widthClassName="max-w-[30rem]">
        <Modal.Header
          title={`Connect ${displayName(server.name)} with an API token`}
          description="The token is checked with the provider, then stored for agent runs."
        />
        <div className="flex flex-col gap-4">
          {tokenPage ? (
            <div className="text-supporting leading-snug text-dim">
              Create a token at{" "}
              <a
                className="underline hover:text-fg"
                href={tokenPage.url}
                target="_blank"
                rel="noreferrer"
              >
                {tokenPage.label}
              </a>
              , then paste it here.
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <span className="text-supporting text-dim">Connect as</span>
            <Segmented
              label="Connect as"
              size="sm"
              value={scope}
              onValueChange={(next) => {
                if (next === "shared" || next === "me") setScope(next);
              }}
            >
              <SegmentedOption value="shared">Workspace</SegmentedOption>
              <SegmentedOption value="me">My account</SegmentedOption>
            </Segmented>
          </div>
          <input
            type="password"
            className={cn(settingsInputClass, "font-mono")}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste API token"
            autoComplete="off"
            spellCheck={false}
            aria-label="API token"
          />
          {error && <InlineAlert>{error}</InlineAlert>}
          <Modal.Footer>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!token.trim() || saving}
              onClick={() => void connect()}
            >
              {saving ? "Checking" : "Connect"}
            </Button>
          </Modal.Footer>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}

export function AddMcpForm({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      const envValues = parseMcpEnvironment(env);
      const allowed = allowedUsers
        .split(",")
        .map((user) => user.trim())
        .filter(Boolean);
      await request("/connections/mcp", {
        method: "POST",
        body: {
          name,
          transport,
          url: transport === "http" ? url.trim() : undefined,
          command: transport === "stdio" ? command.trim() : undefined,
          args:
            transport === "stdio"
              ? args.split(/\s+/).filter(Boolean)
              : undefined,
          env: transport === "stdio" ? envValues : undefined,
          allowedUsers: allowed.length ? allowed : undefined,
        },
        label: "Could not add MCP server",
      });
      onAdded();
    } catch (cause) {
      setError(errorMessage(cause, "Could not add MCP server"));
      setSaving(false);
    }
  }

  const valid =
    name.trim() && (transport === "http" ? url.trim() : command.trim());

  return (
    <SettingsForm className="mb-[18px] flex flex-col gap-3.5">
      <SettingsFormTitle>Add MCP server</SettingsFormTitle>

      <SettingsFormRow>
        <SettingsField>
          Name
          <input
            className={settingsInputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="github"
          />
        </SettingsField>
        <SettingsField>
          Transport
          <OptionSelect
            label="Transport"
            value={transport}
            options={[
              { value: "http", label: "http · remote MCP endpoint" },
              { value: "stdio", label: "stdio · local command" },
            ]}
            onChange={(next) => {
              if (next === "http" || next === "stdio") setTransport(next);
            }}
          />
        </SettingsField>
      </SettingsFormRow>

      {transport === "http" ? (
        <SettingsField>
          URL
          <input
            className={settingsInputClass}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.example.com/mcp"
          />
        </SettingsField>
      ) : (
        <>
          <SettingsFormRow>
            <SettingsField>
              Command
              <input
                className={settingsInputClass}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="~/bin/my-mcp"
              />
            </SettingsField>
            <SettingsField>
              Args (space-separated)
              <input
                className={settingsInputClass}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="run /path/to/server.ts"
              />
            </SettingsField>
          </SettingsFormRow>
          <SettingsField>
            Env (KEY=VALUE, one per line, stored in mcp-config.json)
            <textarea
              className={cn(settingsInputClass, "resize-y font-mono")}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              rows={2}
              placeholder={"API_KEY=${MY_API_KEY}"}
            />
          </SettingsField>
        </>
      )}

      <SettingsField>
        Allowed users (optional, comma-separated, blank for everyone)
        <input
          className={settingsInputClass}
          value={allowedUsers}
          onChange={(e) => setAllowedUsers(e.target.value)}
          placeholder="Alice, Bob"
        />
      </SettingsField>

      {error && <InlineAlert>{error}</InlineAlert>}

      <SettingsFormActions>
        <Button variant="soft" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleAdd}
          disabled={saving || !valid}
        >
          {saving ? "Adding…" : "Add server"}
        </Button>
      </SettingsFormActions>
    </SettingsForm>
  );
}
