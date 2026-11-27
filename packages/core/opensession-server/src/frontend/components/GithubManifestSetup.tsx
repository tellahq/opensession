import { useEffect, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { BASE_PATH } from "../lib/base";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { cn } from "../ui/cn";
import { Input } from "../ui/input";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { SettingsHint } from "../ui/settings";
import { duration } from "../ui/motion";
import { InlineAlert } from "../ui/state";
import { Tooltip } from "../ui/tooltip";
import { IconTile } from "./BrandTile";
import { GithubAccountApps } from "./GithubAccountApps";
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

interface GithubManifestRequest {
  owner: GithubAppOwnerType;
  returnTo: "welcome" | "settings";
  organization?: string;
  public?: boolean;
}

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
    <div className="group relative min-h-11">
      <Button
        size="lg"
        className={cn(
          "absolute inset-0 min-h-11 w-full",
          complete && "disabled:opacity-100",
        )}
        disabled={actionDisabled}
        onClick={onClick}
        {...(href
          ? { render: <a href={href} target="_blank" rel="noreferrer" /> }
          : {})}
      >
        <span className="sr-only">{label}</span>
      </Button>
      <div className="pointer-events-none relative z-10 flex min-h-11 items-center px-3.5 text-base font-medium text-dim">
        <span
          aria-hidden="true"
          className={cn(
            "flex items-center gap-2 transition-colors duration-[var(--dur-micro)] group-hover:text-fg",
            actionDisabled && !complete && "opacity-40 group-hover:text-dim",
          )}
        >
          <IconCheckCircleFilled
            size={20}
            className={complete ? "text-green" : "text-faint"}
          />
          <span className="[text-box:trim-both_cap_alphabetic]">{label}</span>
        </span>
        <Tooltip
          side="top"
          align="center"
          offset={6}
          multiline
          popupClassName="max-w-[424px]! p-2!"
          label={
            <span className="block w-[400px] max-w-[calc(100vw-32px)] whitespace-normal">
              <img
                src={guide}
                alt=""
                className="block h-auto w-full rounded-md border border-[var(--tooltip-ring)]"
              />
              <span className="block px-1 pt-2 pb-1 text-left text-supporting leading-snug font-normal text-tooltip-fg/75">
                {caption}
              </span>
            </span>
          }
        >
          <button
            type="button"
            aria-label={`Show help for ${label.toLowerCase()}`}
            className="focus-ring pointer-events-auto ml-auto flex size-6 items-center justify-center rounded-control text-faint transition-colors duration-[var(--dur-micro)] hover:text-fg phone:size-8"
          >
            <IconQuestionCircle size={20} />
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
  const [multiAccount, setMultiAccount] = useState(false);
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
      const json: GithubManifestRequest = { owner, returnTo };
      if (owner === "organization") {
        json.organization = installationOwner.trim();
      }
      if (multiAccount) {
        json.public = true;
      }
      const body = await setupRequest<{ action: string; manifest: string }>(
        "/api/setup/github/manifest",
        { method: "POST", json },
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
          <div className="flex items-center justify-center gap-2 pb-5">
            <IconTile name="github" size={48} />
            <span aria-hidden="true" className="flex gap-1">
              <span className="size-1 bg-line-strong" />
              <span className="size-1 bg-line-strong" />
              <span className="size-1 bg-line-strong" />
              <span className="size-1 bg-line-strong" />
            </span>
            <img
              src={`${BASE_PATH}/mac-app-icon.png`}
              alt=""
              className="size-12 shrink-0"
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 text-dialog-title font-semibold text-fg">
              Install Open Session for GitHub
            </div>
            <StateChip
              tone={connectionStatus.tone}
              label={connectionStatus.label}
            />
          </div>
        </>
      ) : (
        <div className="text-dialog-title font-semibold text-fg">
          Install Open Session for GitHub
        </div>
      )}
      <div
        className={cn(
          "flex flex-col",
          formOwner === "organization" ? "gap-5" : "gap-2",
        )}
      >
        <div className="text-label font-medium text-dim">App owner</div>
        <Segmented
          label="GitHub App owner"
          value={owner}
          onValueChange={(value) => {
            if (value === "personal" || value === "organization") {
              setOwner(value);
            }
          }}
          className="w-full"
        >
          <SegmentedOption
            value="personal"
            className="flex-1 text-center phone:min-h-11 [&>span:last-child]:justify-center"
          >
            Personal account
          </SegmentedOption>
          <SegmentedOption
            value="organization"
            className="flex-1 text-center phone:min-h-11 [&>span:last-child]:justify-center"
          >
            Organization
          </SegmentedOption>
        </Segmented>
        {formOwner === "organization" && (
          <label className="flex flex-col gap-1">
            <span className="text-label font-medium text-dim">
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
              className="phone:min-h-11 phone:text-input-phone"
              disabled={starting}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
      </div>
      {!github.clientIdConfigured && (
        <div className="flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-supporting text-fg">
            <Checkbox
              checked={multiAccount}
              onCheckedChange={(next) => setMultiAccount(Boolean(next))}
              disabled={starting}
            />
            <span>
              Allow installing on multiple accounts (personal + organization)
            </span>
          </label>
          <p className="m-0 pl-6 text-meta leading-snug text-faint">
            {multiAccount
              ? "Creates a public GitHub App so one App can be installed on both your organization and personal account."
              : "Leave off for a private App on one account only. You can add another App for a personal or organization account below."}
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2">
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
              <strong className="font-semibold text-tooltip-fg">
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
          caption="Choose the repositories Open Session can access on the account that owns the App. For another account, add a GitHub App for it below."
          href={installUrl}
        />
      </div>
      {github.clientIdConfigured && <GithubAccountApps returnTo={returnTo} />}
      {result === "created" && (
        <SettingsHint className="m-0">
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
