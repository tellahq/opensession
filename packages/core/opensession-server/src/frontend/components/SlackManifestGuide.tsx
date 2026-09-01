import { utilityClassName } from "../ui/cn";
import { Button } from "../ui/button";
import { CopyCheck, useCopy } from "../ui/copy";
import { Disclosure } from "../ui/disclosure";
import { PRODUCT_NAME, PUBLIC_BASE_URL, WEBHOOK_BASE_URL } from "../lib/brand";
import { slackCreateAppUrl, slackManifestJson } from "../lib/slack-manifest";
import type { SlackTransport } from "../lib/slack-setup";
import { IconCopy } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  roundedLg: {
    borderRadius: "calc(14px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  p3: {
    padding: "calc(4px * 3)",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  m0: {
    margin: "0",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  maxH72: {
    maxHeight: "calc(4px * 72)",
  },
  overflowAuto: {
    overflow: "auto",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  p25: {
    padding: "calc(4px * 2.5)",
  },
  fontMono: {
    fontFamily: "var(--mono)",
  },
});

/**
 * Creates the Slack app from generated configuration instead of asking the
 * person to transcribe scopes, subscriptions, and request URLs. The transport
 * comes from the dialog's credential choice so the manifest and form agree.
 */
export function SlackManifestGuide({
  transport,
}: {
  transport: SlackTransport;
}) {
  const options = {
    publicBaseUrl: PUBLIC_BASE_URL,
    webhookBaseUrl: WEBHOOK_BASE_URL,
    transport,
    appName: PRODUCT_NAME,
  };
  const json = slackManifestJson(options);
  const { copied, copy } = useCopy();

  return (
    <div
      {...stylex.props(
        sx.flex,
        sx.flexCol,
        sx.gap3,
        sx.roundedLg,
        sx.bgSurface,
        sx.p3,
      )}
    >
      <div {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.gap2)}>
        <Button
          variant="primary"
          size="sm"
          render={
            <a
              href={slackCreateAppUrl(options)}
              target="_blank"
              rel="noreferrer"
            />
          }
        >
          Create Slack app
        </Button>
        <Button
          size="sm"
          onClick={() => copy(json, { toast: "Manifest copied" })}
        >
          <CopyCheck copied={copied} size={14} idle={<IconCopy size={14} />} />
          {copied ? "Copied" : "Copy manifest"}
        </Button>
      </div>

      <p
        {...stylex.props(
          sx.m0,
          sx.leadingRelaxed,
          sx.textDim,
          typography.supporting,
        )}
      >
        The manifest fills in the scopes, event subscriptions
        {transport === "http" ? ", request URLs" : " and Socket Mode"}, and
        interactivity. Credentials are still yours to paste above.
      </p>

      <Disclosure
        title="Manifest JSON"
        panelClassName={utilityClassName("pt-2")}
      >
        <pre
          {...stylex.props(
            sx.m0,
            sx.maxH72,
            sx.overflowAuto,
            sx.roundedControl,
            sx.bgPanel,
            sx.p25,
            sx.fontMono,
            sx.leadingRelaxed,
            sx.textDim,
            typography.meta,
          )}
        >
          {json}
        </pre>
      </Disclosure>
    </div>
  );
}
