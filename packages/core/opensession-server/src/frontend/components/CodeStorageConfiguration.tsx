import { useEffect, useState } from "react";
import {
  connectCodeStorage,
  disconnectCodeStorage,
  fetchCodeStorageStatus,
  relativeTime,
  type CodeStorageStatus,
} from "../lib/api";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import {
  SettingsField,
  SettingsFormRow,
  SettingsSection,
  StatusChip,
  settingsInputClass,
} from "../ui/settings";
import { InlineAlert, LoadingState } from "../ui/state";

/** The code.storage organization credential and live webhook health. This is
 * part of the code.storage integration modal, alongside its setup guide. */
export function CodeStorageConfiguration({
  onChanged,
}: {
  onChanged?: () => void | Promise<void>;
}) {
  const [status, setStatus] = useState<CodeStorageStatus | null>(null);
  const [org, setOrg] = useState("");
  const [pem, setPem] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    void fetchCodeStorageStatus()
      .then(setStatus)
      .catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load code.storage status",
        ),
      );
  }, []);

  useEffect(() => {
    if (!status?.configured) return;
    const timer = window.setInterval(() => {
      void fetchCodeStorageStatus()
        .then(setStatus)
        .catch(() => {});
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [status?.configured]);

  async function connect() {
    setConnecting(true);
    setError(null);
    setNote(null);
    await (async () => {
      const result = await connectCodeStorage(org.trim(), pem);
      setPem("");
      setNote(
        result.repoCount !== undefined
          ? `Connected. ${result.repoCount} repo${result.repoCount === 1 ? "" : "s"} visible. Register them under Settings → Repositories.`
          : "Connected. Register repositories under Settings → Repositories.",
      );
      setStatus(await fetchCodeStorageStatus());
      await Promise.resolve(onChanged?.()).catch(() => {});
    })().catch(async (cause) => {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not connect code.storage",
      );
      setStatus(await fetchCodeStorageStatus().catch(() => null));
    });
    setConnecting(false);
  }

  async function disconnect() {
    if (
      !confirm(
        "Disconnect code.storage? Sessions on code.storage repos lose push and pull until you reconnect. The key file stays on disk.",
      )
    )
      return;
    setError(null);
    try {
      const result = await disconnectCodeStorage();
      setNote(result.note || "Disconnected.");
      setStatus(await fetchCodeStorageStatus());
      await Promise.resolve(onChanged?.()).catch(() => {});
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not disconnect code.storage",
      );
    }
  }

  async function copy(value: string, which: string) {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(value);
    setCopied(which);
    window.setTimeout(
      () => setCopied((current) => (current === which ? null : current)),
      1500,
    );
  }

  if (!status) {
    return (
      <SettingsSection className="p-4">
        {error ? (
          <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
        ) : (
          <LoadingState>Checking code.storage</LoadingState>
        )}
      </SettingsSection>
    );
  }

  const connected = status.configured;
  const webhook = status.webhook;
  const lastDelivery = webhook?.lastDelivery ?? null;

  return (
    <SettingsSection className="p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[12rem] flex-1">
          <div className="text-item-title font-medium text-fg">Connection</div>
          <div className="mt-0.5 text-supporting leading-snug text-dim">
            {!connected
              ? "Enter the organization and its private signing key."
              : status.error
                ? `Configured for organization “${status.org}”, but the last check failed.`
                : `Connected to organization “${status.org}”${
                    status.repoCount !== undefined
                      ? ` · ${status.repoCount} repo${status.repoCount === 1 ? "" : "s"} visible`
                      : ""
                  }.`}
          </div>
        </div>
        <StatusChip
          label={
            connected ? (status.error ? "Error" : "Connected") : "Not connected"
          }
          dot={
            connected
              ? status.error
                ? "var(--red)"
                : "var(--green)"
              : "var(--line-strong, var(--text-faint))"
          }
        />
        {connected && (
          <Button
            size="sm"
            className="shrink-0 hover:border-red hover:text-red phone:min-h-11"
            onClick={() => void disconnect()}
          >
            Disconnect
          </Button>
        )}
      </div>

      {error && (
        <InlineAlert className="mt-4" onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}
      {note && <div className="mt-3 text-supporting text-dim">{note}</div>}

      {!connected ? (
        <div className="mt-4 flex flex-col gap-4 border-t border-line pt-4">
          <SettingsFormRow>
            <SettingsField>
              Organization
              <input
                className={settingsInputClass}
                value={org}
                onChange={(event) => setOrg(event.target.value)}
                placeholder="acme"
                autoCapitalize="none"
                spellCheck={false}
                aria-label="code.storage organization"
              />
            </SettingsField>
          </SettingsFormRow>
          <SettingsField>
            Private key
            <textarea
              className={cn(settingsInputClass, "resize-y font-mono")}
              value={pem}
              onChange={(event) => setPem(event.target.value)}
              rows={5}
              spellCheck={false}
              placeholder={"-----BEGIN PRIVATE KEY-----\n…"}
              aria-label="code.storage private key PEM"
            />
            <span className="text-supporting font-normal text-faint">
              PKCS8 PEM. Register its public half with the organization first.
            </span>
          </SettingsField>
          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              variant="primary"
              disabled={connecting || !org.trim() || !pem.trim()}
              onClick={() => void connect()}
            >
              {connecting ? "Connecting…" : "Connect"}
            </Button>
            <span className="text-supporting text-faint">
              Stored on this server with mode 0600.
            </span>
          </div>
        </div>
      ) : (
        <>
          {status.error && (
            <div className="mt-3 text-supporting text-red">{status.error}</div>
          )}
          {webhook && (
            <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
              <div className="text-label font-medium text-fg">
                Webhook receiver
              </div>
              <div className="flex flex-wrap items-center gap-2 text-label text-dim">
                <code className="rounded-sm bg-active px-1.5 py-0.5 font-mono text-fg">
                  POST {webhook.path}
                </code>
                <span>on port {webhook.port}, behind your TLS proxy</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void copy(webhook.path, "path")}
                >
                  {copied === "path" ? "Copied" : "Copy path"}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-label text-dim">
                <span>Secret</span>
                <code className="max-w-[340px] truncate rounded-sm bg-active px-1.5 py-0.5 font-mono text-fg">
                  {showSecret ? webhook.secret : "••••••••••••••••"}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowSecret((shown) => !shown)}
                >
                  {showSecret ? "Hide" : "Reveal"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void copy(webhook.secret, "secret")}
                >
                  {copied === "secret" ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="text-supporting leading-snug text-faint">
                Add the public URL and secret in Pierre → Webhooks. Subscribe to
                push and repo.sync events.
              </div>
              <div
                className={cn(
                  "text-meta",
                  lastDelivery && !lastDelivery.ok ? "text-red" : "text-faint",
                )}
              >
                {!lastDelivery
                  ? "No verified deliveries received yet."
                  : lastDelivery.ok
                    ? `Last event: ${lastDelivery.event}${lastDelivery.ref ? ` ${lastDelivery.ref}` : ""}${lastDelivery.repo ? ` (${lastDelivery.repo})` : ""}, ${relativeTime(lastDelivery.at)}`
                    : `Last delivery failed (${lastDelivery.error}), ${relativeTime(lastDelivery.at)}`}
              </div>
              {webhook.lastRejected && (
                <div className="text-supporting leading-snug text-red">
                  {webhook.rejectedCount} unauthenticated request
                  {webhook.rejectedCount === 1 ? "" : "s"} rejected (
                  {webhook.lastRejected.error}), last{" "}
                  {relativeTime(webhook.lastRejected.at)}.
                </div>
              )}
              {webhook.syncFailures.map((failure) => (
                <div key={failure.repo} className="text-meta text-red">
                  Sync failing for {failure.repo}: {failure.error} (
                  {relativeTime(failure.at)})
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </SettingsSection>
  );
}
