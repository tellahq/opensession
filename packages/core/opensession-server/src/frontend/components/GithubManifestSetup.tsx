import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { useEffect, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { BASE_PATH } from "../lib/base";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Input } from "../ui/input";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { SettingsHint } from "../ui/settings";
import { duration } from "../ui/motion";
import { InlineAlert } from "../ui/state";
import { Tooltip } from "../ui/tooltip";
import { IconTile } from "./BrandTile";
import { IconCheckCircleFilled, IconQuestionCircle } from "./icons";
import githubCreateAppGuide from "../assets/github-create-app.svg";
import githubDeviceFlowGuide from "../assets/github-enable-device-flow.svg";
import githubInstallAppGuide from "../assets/github-install-app.svg";
import {
  githubAppCreateOwner,
  githubAppInstallUrlForSlug,
  githubAppSettingsUrlForSlug,
  githubAppSetupOwner,
  githubManifestAction,
  type GithubAppOwnerType,
} from "../lib/github-app-setup";
import {
  StateChip,
  setupRequest,
  type ChipTone,
  type SetupGithub,
} from "./setup-shared";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  relative: {
    position: "relative",
  },
  minH11: {
    minHeight: "calc(4px * 11)",
  },
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0",
  },
  pointerEventsNone: {
    pointerEvents: "none",
  },
  z10: {
    zIndex: "10",
  },
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  px35: {
    paddingInline: "calc(4px * 3.5)",
  },
  textBase: {
    fontSize: "var(--type-body)",
    lineHeight: "var(--tw-leading, var(--text-base--line-height))",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  TextBoxTrimBothCapAlphabetic: {
    textBox: "trim-both cap alphabetic",
  },
  block: {
    display: "block",
  },
  w400px: {
    width: "400px",
  },
  maxWCalc100vw32px: {
    maxWidth: "calc(100vw - 32px)",
  },
  whitespaceNormal: {
    whiteSpace: "normal",
  },
  hAuto: {
    height: "auto",
  },
  wFull: {
    width: "100%",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderVarTooltipRing: {
    borderColor: "var(--tooltip-ring)",
  },
  px1: {
    paddingInline: "4px",
  },
  pt2: {
    paddingTop: "calc(4px * 2)",
  },
  pb1: {
    paddingBottom: "4px",
  },
  textLeft: {
    textAlign: "left",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  fontNormal: {
    fontWeight: "var(--font-weight-normal)",
  },
  textTooltipFg75: {
    color: "color-mix(in oklab, var(--tooltip-fg) 75%, transparent)",
  },
  pointerEventsAuto: {
    pointerEvents: "auto",
  },
  mlAuto: {
    marginLeft: "auto",
  },
  size6: {
    width: "calc(4px * 6)",
    height: "calc(4px * 6)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  transitionColors: {
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  durationVarDurMicro: {
    transitionDuration: "var(--dur-micro)",
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  phoneSize8: {
    "@media (max-width: 720px)": {
      width: "calc(4px * 8)",
      height: "calc(4px * 8)",
    },
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  pb5: {
    paddingBottom: "calc(4px * 5)",
  },
  gap1: {
    gap: "4px",
  },
  size1: {
    width: "4px",
    height: "4px",
  },
  bgLineStrong: {
    backgroundColor: "var(--border-strong)",
  },
  size12: {
    width: "calc(4px * 12)",
    height: "calc(4px * 12)",
  },
  shrink0: {
    flexShrink: "0",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  minW0: {
    minWidth: "0",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  flex1: {
    flex: "1",
  },
  textCenter: {
    textAlign: "center",
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  flexCol: {
    flexDirection: "column",
  },
  phoneTextInputPhone: {
    "@media (max-width: 720px)": {
      fontSize: "var(--type-input-phone)",
    },
  },
  textTooltipFg: {
    color: "var(--tooltip-fg)",
  },
  m0: {
    margin: "0",
  },
});

function GithubSetupStep({
  label,
  guide,
  caption,
  complete = false,
  href,
  disabled,
  onClick,
}: {
  label: string;
  guide: string;
  caption: ReactNode;
  complete?: boolean;
  href?: string | null;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const actionDisabled = disabled || (!href && !onClick);

  return (
    <div {...mergeStylexProps("group", sx.relative, sx.minH11)}>
      <Button
        size="lg"
        className={cn(
          utilityClassName("absolute inset-0 min-h-11 w-full"),
          complete && utilityClassName("disabled:opacity-100"),
        )}
        disabled={actionDisabled}
        onClick={onClick}
        {...(href
          ? { render: <a href={href} target="_blank" rel="noreferrer" /> }
          : {})}
      >
        <span {...stylex.props(sx.srOnly)}>{label}</span>
      </Button>
      <div
        {...stylex.props(
          sx.pointerEventsNone,
          sx.relative,
          sx.z10,
          sx.flex,
          sx.minH11,
          sx.itemsCenter,
          sx.px35,
          sx.textBase,
          sx.fontMedium,
          sx.textDim,
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            utilityClassName(
              "flex items-center gap-2 transition-colors duration-[var(--dur-micro)] group-hover:text-fg",
            ),
            actionDisabled &&
              !complete &&
              utilityClassName("opacity-40 group-hover:text-dim"),
          )}
        >
          <IconCheckCircleFilled
            size={20}
            className={
              complete
                ? utilityClassName("text-green")
                : utilityClassName("text-faint")
            }
          />
          <span {...stylex.props(sx.TextBoxTrimBothCapAlphabetic)}>
            {label}
          </span>
        </span>
        <Tooltip
          side="top"
          align="center"
          offset={6}
          multiline
          popupClassName={utilityClassName("max-w-[424px]! p-2!")}
          label={
            <span
              {...stylex.props(
                sx.block,
                sx.w400px,
                sx.maxWCalc100vw32px,
                sx.whitespaceNormal,
              )}
            >
              <img
                src={guide}
                alt=""
                {...stylex.props(
                  sx.block,
                  sx.hAuto,
                  sx.wFull,
                  sx.roundedMd,
                  sx.border,
                  sx.borderVarTooltipRing,
                )}
              />
              <span
                {...stylex.props(
                  sx.block,
                  sx.px1,
                  sx.pt2,
                  sx.pb1,
                  sx.textLeft,
                  sx.leadingSnug,
                  sx.fontNormal,
                  sx.textTooltipFg75,
                  typography.supporting,
                )}
              >
                {caption}
              </span>
            </span>
          }
        >
          <button
            type="button"
            aria-label={`Show help for ${label.toLowerCase()}`}
            {...mergeStylexProps(
              "focus-ring",
              sx.pointerEventsAuto,
              sx.mlAuto,
              sx.flex,
              sx.size6,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.roundedControl,
              sx.textFaint,
              sx.transitionColors,
              sx.durationVarDurMicro,
              sx.hoverTextFg,
              sx.phoneSize8,
            )}
          >
            <IconQuestionCircle size={18} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

export function GithubManifestSetup({
  github,
  returnTo,
  connectionStatus,
  onContentSizeChange,
}: {
  github: SetupGithub;
  returnTo: "welcome" | "settings";
  connectionStatus?: { tone: ChipTone; label: string };
  onContentSizeChange?: () => void;
}) {
  const initialOwner = githubAppCreateOwner(github.appCreateUrl);
  const [owner, setOwner] = useState<GithubAppOwnerType>(
    githubAppSetupOwner(github),
  );
  // Keep the owner-specific form in place while the segmented knob travels.
  // Once the click has visibly settled, the form can change the modal height
  // without competing with that direct feedback.
  const [formOwner, setFormOwner] = useState(owner);
  const reducedMotion = useReducedMotion();
  const [ownerDrafts, setOwnerDrafts] = useState<
    Record<GithubAppOwnerType, string>
  >({
    personal:
      initialOwner.type === "personal" ? (github.installationOwner ?? "") : "",
    organization:
      github.appOrg ??
      (initialOwner.type === "organization"
        ? (github.installationOwner ?? initialOwner.login)
        : ""),
  });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installationOwner = ownerDrafts[owner];
  const formInstallationOwner = ownerDrafts[formOwner];
  const ownerSwitching = owner !== formOwner;
  const ownerReady = owner === "personal" || Boolean(installationOwner.trim());

  useEffect(() => {
    if (!ownerSwitching) return;
    const reveal = window.setTimeout(
      () => {
        onContentSizeChange?.();
        setFormOwner(owner);
      },
      (reducedMotion ? 0 : duration.base) * 1000,
    );
    return () => window.clearTimeout(reveal);
  }, [owner, ownerSwitching, reducedMotion, onContentSizeChange]);
  const settingsUrl = githubAppSettingsUrlForSlug(
    github.appSlug,
    github.appOrg,
  );
  const installUrl = githubAppInstallUrlForSlug(github.appSlug ?? "");
  const result =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("github_manifest");

  async function createApp() {
    if (starting || !ownerReady) return;
    setStarting(true);
    setError(null);
    try {
      const body = await setupRequest<{ action: string; manifest: string }>(
        "/api/setup/github/manifest",
        {
          method: "POST",
          json: {
            owner,
            returnTo,
            ...(owner === "organization"
              ? { organization: installationOwner.trim() }
              : {}),
          },
        },
      );
      const action = githubManifestAction(body.action);
      if (!action) {
        setError("GitHub returned an invalid App registration address");
        setStarting(false);
        return;
      }
      const form = document.createElement("form");
      form.method = "post";
      form.action = action;
      form.hidden = true;
      const manifest = document.createElement("input");
      manifest.type = "hidden";
      manifest.name = "manifest";
      manifest.value = body.manifest;
      form.append(manifest);
      document.body.append(form);
      if (returnTo === "welcome") {
        window.sessionStorage.setItem("opensession:first-mile-step", "github");
      }
      form.submit();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not start GitHub App setup",
      );
      setStarting(false);
    }
  }

  return (
    <>
      {connectionStatus ? (
        <>
          <div
            {...stylex.props(
              sx.flex,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.gap2,
              sx.pb5,
            )}
          >
            <IconTile name="github" size={48} />
            <span aria-hidden="true" {...stylex.props(sx.flex, sx.gap1)}>
              <span {...stylex.props(sx.size1, sx.bgLineStrong)} />
              <span {...stylex.props(sx.size1, sx.bgLineStrong)} />
              <span {...stylex.props(sx.size1, sx.bgLineStrong)} />
              <span {...stylex.props(sx.size1, sx.bgLineStrong)} />
            </span>
            <img
              src={`${BASE_PATH}/mac-app-icon.png`}
              alt=""
              {...stylex.props(sx.size12, sx.shrink0)}
            />
          </div>
          <div
            {...stylex.props(
              sx.flex,
              sx.itemsCenter,
              sx.justifyBetween,
              sx.gap4,
            )}
          >
            <div
              {...stylex.props(
                sx.minW0,
                sx.fontSemibold,
                sx.textFg,
                typography.dialogTitle,
              )}
            >
              Install Open Session for GitHub
            </div>
            <StateChip
              tone={connectionStatus.tone}
              label={connectionStatus.label}
            />
          </div>
        </>
      ) : (
        <div
          {...stylex.props(sx.fontSemibold, sx.textFg, typography.dialogTitle)}
        >
          Install Open Session for GitHub
        </div>
      )}
      <div
        className={cn(
          utilityClassName("flex flex-col"),
          formOwner === "organization"
            ? utilityClassName("gap-5")
            : utilityClassName("gap-2"),
        )}
      >
        <Segmented
          label="GitHub App owner"
          value={owner}
          onValueChange={(value) => setOwner(value as GithubAppOwnerType)}
          className={mergeStylexOverrideClassName("", sx.wFull)}
        >
          <SegmentedOption
            value="personal"
            className={mergeStylexOverrideClassName(
              "[&>span:last-child]:justify-center",
              sx.flex1,
              sx.textCenter,
              sx.phoneMinH11,
            )}
          >
            Personal account
          </SegmentedOption>
          <SegmentedOption
            value="organization"
            className={mergeStylexOverrideClassName(
              "[&>span:last-child]:justify-center",
              sx.flex1,
              sx.textCenter,
              sx.phoneMinH11,
            )}
          >
            Organization
          </SegmentedOption>
        </Segmented>
        {formOwner === "organization" && (
          <label {...stylex.props(sx.flex, sx.flexCol, sx.gap1)}>
            <span
              {...stylex.props(sx.fontMedium, sx.textDim, typography.label)}
            >
              Organization ID
            </span>
            <Input
              value={formInstallationOwner}
              onChange={(event) =>
                setOwnerDrafts((current) => ({
                  ...current,
                  organization: event.target.value,
                }))
              }
              placeholder="my-organization"
              className={mergeStylexOverrideClassName(
                "",
                sx.phoneMinH11,
                sx.phoneTextInputPhone,
              )}
              disabled={starting}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
      </div>
      <div {...stylex.props(sx.flex, sx.flexCol, sx.gap2)}>
        <GithubSetupStep
          label="Create GitHub app"
          guide={githubCreateAppGuide}
          caption="Keep the suggested name, then create the GitHub App for your account or organization."
          complete={github.clientIdConfigured}
          disabled={
            github.clientIdConfigured ||
            !ownerReady ||
            ownerSwitching ||
            starting
          }
          onClick={() => void createApp()}
        />
        <GithubSetupStep
          label="Enable Device Flow"
          guide={githubDeviceFlowGuide}
          caption={
            <>
              Leave OAuth during installation off, then turn on Enable Device
              Flow. Click “
              <strong {...stylex.props(sx.fontSemibold, sx.textTooltipFg)}>
                Save changes
              </strong>
              ” to finish.
            </>
          }
          href={settingsUrl}
        />
        <GithubSetupStep
          label="Install GitHub app"
          guide={githubInstallAppGuide}
          caption="Choose all repositories or select the repositories Open Session can access, then click Install."
          href={installUrl}
        />
      </div>
      {result === "created" && (
        <SettingsHint className={mergeStylexOverrideClassName("", sx.m0)}>
          GitHub App created. Enable Device Flow before you install it.
        </SettingsHint>
      )}
      {result === "error" && (
        <InlineAlert>
          GitHub App setup could not be completed. Try again.
        </InlineAlert>
      )}
      {error && <InlineAlert>{error}</InlineAlert>}
    </>
  );
}
