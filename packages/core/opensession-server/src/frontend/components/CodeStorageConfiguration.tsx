import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  p4: {
    padding: "calc(4px * 4)",
  },
  flex: {
    display: "flex",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  minW12rem: {
    minWidth: "12rem",
  },
  flex1: {
    flex: "1",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  shrink0: {
    flexShrink: "0",
  },
  hoverBorderRed: {
    "@media (hover: hover)": {
      ":hover": {
        borderColor: "var(--red)",
      },
    },
  },
  hoverTextRed: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--red)",
      },
    },
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  mt4: {
    marginTop: "calc(4px * 4)",
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  borderT: {
    borderTopStyle: "solid",
    borderTopWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  pt4: {
    paddingTop: "calc(4px * 4)",
  },
  fontNormal: {
    fontWeight: "var(--font-weight-normal)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  textRed: {
    color: "var(--red)",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgActive: {
    backgroundColor: "var(--bg-active)",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  py05: {
    paddingBlock: "calc(4px * 0.5)",
  },
  fontMono: {
    fontFamily: "var(--mono)",
  },
  maxW340px: {
    maxWidth: "340px",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

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
        typeof result.repoCount === "number"
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
      <SettingsSection className={mergeStylexOverrideClassName("", sx.p4)}>
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
    <SettingsSection className={mergeStylexOverrideClassName("", sx.p4)}>
      <div {...stylex.props(sx.flex, sx.flexWrap, sx.itemsStart, sx.gap3)}>
        <div {...stylex.props(sx.minW12rem, sx.flex1)}>
          <div
            {...stylex.props(sx.fontMedium, sx.textFg, typography.itemTitle)}
          >
            Connection
          </div>
          <div
            {...stylex.props(
              sx.mt05,
              sx.leadingSnug,
              sx.textDim,
              typography.supporting,
            )}
          >
            {!connected
              ? "Enter the organization and its private signing key."
              : status.error
                ? `Configured for organization “${status.org}”, but the last check failed.`
                : `Connected to organization “${status.org}”${
                    typeof status.repoCount === "number"
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
            className={mergeStylexOverrideClassName(
              "",
              sx.shrink0,
              sx.hoverBorderRed,
              sx.hoverTextRed,
              sx.phoneMinH11,
            )}
            onClick={() => void disconnect()}
          >
            Disconnect
          </Button>
        )}
      </div>

      {error && (
        <InlineAlert
          className={mergeStylexOverrideClassName("", sx.mt4)}
          onDismiss={() => setError(null)}
        >
          {error}
        </InlineAlert>
      )}
      {note && (
        <div {...stylex.props(sx.mt3, sx.textDim, typography.supporting)}>
          {note}
        </div>
      )}

      {!connected ? (
        <div
          {...stylex.props(
            sx.mt4,
            sx.flex,
            sx.flexCol,
            sx.gap4,
            sx.borderT,
            sx.borderLine,
            sx.pt4,
          )}
        >
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
              className={cn(
                settingsInputClass,
                utilityClassName("resize-y font-mono"),
              )}
              value={pem}
              onChange={(event) => setPem(event.target.value)}
              rows={5}
              spellCheck={false}
              placeholder={"-----BEGIN PRIVATE KEY-----\n…"}
              aria-label="code.storage private key PEM"
            />
            <span
              {...stylex.props(
                sx.fontNormal,
                sx.textFaint,
                typography.supporting,
              )}
            >
              PKCS8 PEM. Register its public half with the organization first.
            </span>
          </SettingsField>
          <div
            {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.gap25)}
          >
            <Button
              variant="primary"
              disabled={connecting || !org.trim() || !pem.trim()}
              onClick={() => void connect()}
            >
              {connecting ? "Connecting…" : "Connect"}
            </Button>
            <span {...stylex.props(sx.textFaint, typography.supporting)}>
              Stored on this server with mode 0600.
            </span>
          </div>
        </div>
      ) : (
        <>
          {status.error && (
            <div {...stylex.props(sx.mt3, sx.textRed, typography.supporting)}>
              {status.error}
            </div>
          )}
          {webhook && (
            <div
              {...stylex.props(
                sx.mt4,
                sx.flex,
                sx.flexCol,
                sx.gap2,
                sx.borderT,
                sx.borderLine,
                sx.pt4,
              )}
            >
              <div
                {...stylex.props(sx.fontMedium, sx.textFg, typography.label)}
              >
                Webhook receiver
              </div>
              <div
                {...stylex.props(
                  sx.flex,
                  sx.flexWrap,
                  sx.itemsCenter,
                  sx.gap2,
                  sx.textDim,
                  typography.label,
                )}
              >
                <code
                  {...stylex.props(
                    sx.roundedSm,
                    sx.bgActive,
                    sx.px15,
                    sx.py05,
                    sx.fontMono,
                    sx.textFg,
                  )}
                >
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
              <div
                {...stylex.props(
                  sx.flex,
                  sx.flexWrap,
                  sx.itemsCenter,
                  sx.gap2,
                  sx.textDim,
                  typography.label,
                )}
              >
                <span>Secret</span>
                <code
                  {...stylex.props(
                    sx.maxW340px,
                    sx.truncate,
                    sx.roundedSm,
                    sx.bgActive,
                    sx.px15,
                    sx.py05,
                    sx.fontMono,
                    sx.textFg,
                  )}
                >
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
              <div
                {...stylex.props(
                  sx.leadingSnug,
                  sx.textFaint,
                  typography.supporting,
                )}
              >
                Add the public URL and secret in Pierre → Webhooks. Subscribe to
                push and repo.sync events.
              </div>
              <div
                className={cn(
                  utilityClassName("text-meta"),
                  lastDelivery && !lastDelivery.ok
                    ? utilityClassName("text-red")
                    : utilityClassName("text-faint"),
                )}
              >
                {!lastDelivery
                  ? "No verified deliveries received yet."
                  : lastDelivery.ok
                    ? `Last event: ${lastDelivery.event}${lastDelivery.ref ? ` ${lastDelivery.ref}` : ""}${lastDelivery.repo ? ` (${lastDelivery.repo})` : ""}, ${relativeTime(lastDelivery.at)}`
                    : `Last delivery failed (${lastDelivery.error}), ${relativeTime(lastDelivery.at)}`}
              </div>
              {webhook.lastRejected && (
                <div
                  {...stylex.props(
                    sx.leadingSnug,
                    sx.textRed,
                    typography.supporting,
                  )}
                >
                  {webhook.rejectedCount} unauthenticated request
                  {webhook.rejectedCount === 1 ? "" : "s"} rejected (
                  {webhook.lastRejected.error}), last{" "}
                  {relativeTime(webhook.lastRejected.at)}.
                </div>
              )}
              {webhook.syncFailures.map((failure) => (
                <div
                  key={failure.repo}
                  {...stylex.props(sx.textRed, typography.meta)}
                >
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
