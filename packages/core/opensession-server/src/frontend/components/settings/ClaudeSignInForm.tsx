import { useEffect, useState } from "react";
import { request } from "../../lib/api/request";
import { errorMessage } from "../../lib/error-message";
import { providerAccountLabel } from "../../lib/provider-account";
import { Button } from "../../ui/button";
import { Field, Input } from "../../ui/input";
import { SettingRowDescription } from "../../ui/settings";
import { InlineAlert, LoadingState } from "../../ui/state";
import { toast } from "../../ui/toast";
import { IconPlug } from "../icons";

/** Connect PKCE usage credentials without replacing a setup token. */
export function ClaudeSignInForm({
  account,
  onClose,
  onDone,
}: {
  account: {
    id: string;
    name: string;
    email?: string;
    authKind: "setup-token" | "oauth";
  };
  onClose: () => void;
  onDone: () => void;
}) {
  const [login, setLogin] = useState<{ id: string; url: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void request<{ id: string; url: string }>("/claude-accounts/oauth-login", {
      method: "POST",
      body: { accountId: account.id },
      label: "Could not start Claude sign-in",
    }).then(
      (nextLogin) => {
        if (!cancelled) setLogin(nextLogin);
      },
      (cause: unknown) => {
        if (!cancelled)
          setError(errorMessage(cause, "Could not start Claude sign-in"));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [account.id]);

  function handleClose() {
    if (login) {
      void request(
        `/claude-accounts/oauth-login/${encodeURIComponent(login.id)}`,
        { method: "DELETE", label: "Could not cancel Claude sign-in" },
      ).catch(() => undefined);
    }
    onClose();
  }

  async function handleConnect() {
    if (!login) return;
    setBusy(true);
    setError(null);
    try {
      await request(
        `/claude-accounts/oauth-login/${encodeURIComponent(login.id)}`,
        {
          method: "POST",
          body: { code },
          label: "Could not connect Anthropic usage tracking",
        },
      );
      toast(`Usage tracking connected for ${providerAccountLabel(account)}`);
      onDone();
    } catch (cause) {
      setError(
        errorMessage(cause, "Could not connect Anthropic usage tracking"),
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3.5 bg-panel px-5 py-3.5">
      <SettingRowDescription>
        {account.authKind === "oauth"
          ? "Reconnect this account for model runs and usage tracking. "
          : "Connect usage tracking. Runs keep using the existing setup token. "}
        Open the link, sign in as{" "}
        {account.email ? (
          <b>{account.email}</b>
        ) : (
          "the Claude account behind this token"
        )}
        , then paste the code Claude shows you.
      </SettingRowDescription>

      {login ? (
        <div className="flex items-end gap-3.5 phone:flex-col phone:items-stretch">
          <a
            className="shrink-0"
            href={login.url}
            target="_blank"
            rel="noreferrer"
          >
            <Button icon={<IconPlug size={16} />}>Open Claude sign-in</Button>
          </a>
          <Field className="flex-1" label="Code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste the code from the sign-in page (…#…)"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
        </div>
      ) : !error ? (
        <LoadingState placement="row">Preparing sign-in…</LoadingState>
      ) : null}

      {error && <InlineAlert>{error}</InlineAlert>}

      <div className="flex justify-end gap-2.5">
        <Button variant="soft" onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleConnect}
          disabled={busy || !login || !code.trim()}
        >
          {busy ? "Connecting…" : "Connect usage"}
        </Button>
      </div>
    </div>
  );
}
