import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useEffect, useState } from "react";
import { useSetupStatus } from "../hooks/useSetupStatus";
import { DEFAULT_DOC_TITLE, docTitle } from "../lib/brand";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { SettingCard, SettingsHeader, SettingsPanel } from "../ui/settings";
import { LoadingState } from "../ui/state";
import { SetupChecklist } from "./SetupChecklist";
import { IntegrationsList } from "./SetupIntegrations";
import { ReposSection } from "./SetupRepos";
import { SetupRestart } from "./SetupRestart";
import { TeamSection } from "./SetupTeam";
import { OrganizationProfileSection } from "./settings/GeneralPanel";
import { IngressPanel } from "./settings/IngressPanel";
import { ProviderAccountsSection } from "./settings/ModelAccounts";
import { ModelProvidersPanel } from "./ModelProviders";
import { ModelDefaultsSection } from "./Models";
import { IconCheck } from "./icons";
import { integrationState, type SetupStatus } from "./setup-shared";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  mt10: {
    marginTop: "calc(4px * 10)",
  },
  mb2: {
    marginBottom: "calc(4px * 2)",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  flex: {
    display: "flex",
  },
  wFull: {
    width: "100%",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  textLeft: {
    textAlign: "left",
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
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  fontTitle: {
    fontWeight: "var(--title-weight)",
  },
  tracking0015em: {
    letterSpacing: "-0.015em",
  },
  textFg: {
    color: "var(--text)",
  },
  mt15: {
    marginTop: "calc(4px * 1.5)",
  },
  maxW62ch: {
    maxWidth: "62ch",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  relative: {
    position: "relative",
  },
  maxW980px: {
    maxWidth: "980px",
  },
  grid: {
    display: "grid",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  minW0: {
    minWidth: "0",
  },
  mt0: {
    marginTop: "0",
  },
});

// Settings → Setup: every part of a new instance, in the order someone fills
// it in, with a summary rail that jumps to the section that still needs work.
// Sections match the onboarding steps, so the two never disagree on what
// "set up" means.

type SectionId =
  | "github"
  | "organisation"
  | "domains"
  | "providers"
  | "repositories"
  | "members"
  | "review";

function sectionAnchor(id: SectionId) {
  return `setup-${id}`;
}

function scrollToSection(id: SectionId) {
  const target = document.getElementById(sectionAnchor(id));
  if (!target) return;
  const reduced = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  target.scrollIntoView({
    behavior: reduced ? "auto" : "smooth",
    block: "start",
  });
}

function SetupSummary({
  status,
  domainsReady,
  onSelect,
}: {
  status: SetupStatus;
  domainsReady: boolean;
  onSelect: (id: SectionId) => void;
}) {
  const github = status.integrations.find(
    (integration) => integration.id === "github",
  );
  const githubReady = !!github && integrationState(github).tone === "on";
  const requiredReady =
    githubReady &&
    status.engine.ready &&
    status.repos.length > 0 &&
    status.team.count > 0;
  const steps: { id: SectionId; label: string; complete: boolean }[] = [
    { id: "github", label: "GitHub", complete: githubReady },
    { id: "organisation", label: "Organisation", complete: true },
    { id: "domains", label: "Domains", complete: domainsReady },
    { id: "providers", label: "Providers", complete: status.engine.ready },
    {
      id: "repositories",
      label: "Repositories",
      complete: status.repos.length > 0,
    },
    { id: "members", label: "Members", complete: status.team.count > 0 },
    { id: "review", label: "Review", complete: requiredReady },
  ];

  return (
    <aside
      aria-labelledby="setup-summary-title"
      {...mergeStylexProps(
        "desktop:sticky desktop:top-0 desktop:col-start-2 desktop:row-start-1 desktop:mt-0",
        sx.mt10,
      )}
    >
      <h2
        id="setup-summary-title"
        {...mergeStylexProps(
          "m-0",
          sx.mb2,
          sx.px4,
          sx.fontSemibold,
          sx.textFaint,
          typography.label,
        )}
      >
        Summary
      </h2>
      <SettingCard>
        {steps.map((step) => (
          <button
            key={step.id}
            type="button"
            onClick={() => onSelect(step.id)}
            {...mergeStylexProps(
              "focus-ring hover:bg-hover",
              sx.flex,
              sx.wFull,
              sx.cursorPointer,
              sx.itemsCenter,
              sx.gap25,
              sx.px4,
              sx.py3,
              sx.textLeft,
            )}
          >
            <span
              className={cn(
                utilityClassName(
                  "flex size-5 shrink-0 items-center justify-center rounded-full",
                ),
                step.complete
                  ? utilityClassName("bg-green-soft text-green")
                  : utilityClassName("bg-hover text-faint"),
              )}
              aria-hidden="true"
            >
              <IconCheck size={14} />
            </span>
            <span
              className={cn(
                utilityClassName("min-w-0 text-label"),
                step.complete
                  ? utilityClassName("font-medium text-fg")
                  : utilityClassName("text-dim"),
              )}
            >
              {step.label}
            </span>
            <span {...stylex.props(sx.srOnly)}>
              {step.complete ? ", complete" : ", needs setup"}
            </span>
          </button>
        ))}
      </SettingCard>
    </aside>
  );
}

function SetupPageSection({
  id,
  title,
  description,
  children,
  className = "mt-10",
}: {
  id: SectionId;
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={sectionAnchor(id)}
      className={cn(utilityClassName("scroll-mt-4"), className)}
    >
      <div {...stylex.props(sx.mb3, sx.px5)}>
        <h2
          {...mergeStylexProps(
            "m-0",
            sx.fontTitle,
            sx.tracking0015em,
            sx.textFg,
            typography.sectionTitle,
          )}
        >
          {title}
        </h2>
        <p
          {...mergeStylexProps(
            "m-0",
            sx.mt15,
            sx.maxW62ch,
            sx.leadingRelaxed,
            sx.textDim,
            typography.supporting,
          )}
        >
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

export function SetupPanel({
  onOpenOnboarding,
}: {
  onOpenOnboarding: () => void;
}) {
  const setup = useSetupStatus();
  const { status, failed, refetch } = setup;
  const [aiRevision, setAiRevision] = useState(0);
  const [domainsReady, setDomainsReady] = useState(false);

  useEffect(() => {
    document.title = docTitle("Setup");
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, []);

  async function refreshAi() {
    setAiRevision((revision) => revision + 1);
    await refetch();
  }

  return (
    <SettingsPanel
      className={mergeStylexOverrideClassName(
        "[&_input]:phone:text-input-phone",
        sx.relative,
        sx.maxW980px,
      )}
    >
      <SettingsHeader
        title="Workspace setup"
        actions={
          <Button size="sm" onClick={onOpenOnboarding}>
            Open onboarding
          </Button>
        }
      />
      {!status ? (
        <LoadingState>
          {failed ? "Couldn't load setup status." : "Loading…"}
        </LoadingState>
      ) : (
        <div
          {...mergeStylexProps(
            "desktop:grid-cols-[minmax(0,720px)_220px] desktop:gap-10",
            sx.grid,
            sx.itemsStart,
          )}
        >
          <div
            {...mergeStylexProps(
              "desktop:col-start-1 desktop:row-start-1",
              sx.minW0,
            )}
          >
            <SetupPageSection
              id="github"
              title="Connect GitHub"
              description="The GitHub App controls repository access. PR automation is optional."
              className={mergeStylexOverrideClassName("", sx.mt0)}
            >
              <IntegrationsList
                integrations={status.integrations.filter(
                  (integration) => integration.id === "github",
                )}
                onSaved={setup.applyIntegration}
                github={status.github}
                onGithubSaved={setup.applyGithub}
              />
            </SetupPageSection>

            <SetupPageSection
              id="organisation"
              title="Organisation"
              description="Your organisation's name and mark, and the names this instance and its agent use when they introduce themselves."
            >
              <OrganizationProfileSection />
            </SetupPageSection>

            <SetupPageSection
              id="domains"
              title="Domains"
              description="Connect the private domain your team uses and the public callback external services need."
            >
              <IngressPanel
                embedded
                setup={setup}
                initialUrls={{
                  app: status.access.publicBaseUrl,
                  callback: status.ingress?.publicBaseUrl || "",
                }}
                onChanged={refetch}
                onStatusChange={(settings) =>
                  setDomainsReady(
                    settings.app.domain.health === "ready" &&
                      settings.health === "ready",
                  )
                }
              />
            </SetupPageSection>

            <SetupPageSection
              id="providers"
              title="Providers"
              description="All providers available to runs, with the accounts connected to each one."
            >
              <ModelDefaultsSection key={aiRevision} />
              <ProviderAccountsSection onChanged={refreshAi} />
              <ModelProvidersPanel />
            </SetupPageSection>

            <SetupPageSection
              id="repositories"
              title="Add repositories"
              description="Register the repositories sessions can work in."
            >
              <ReposSection
                repos={status.repos}
                onChanged={refetch}
                onRepoUpdated={setup.applyRepo}
              />
            </SetupPageSection>

            <SetupPageSection
              id="members"
              title="Members"
              description="Everyone who uses this instance, so sessions and commits attribute to real people."
            >
              <TeamSection onChanged={refetch} />
            </SetupPageSection>

            <SetupPageSection
              id="review"
              title="Review"
              description="Everything this instance needs, and what each part is doing right now."
            >
              <SetupChecklist status={status} onChanged={refetch} />
            </SetupPageSection>
          </div>
          <SetupSummary
            status={status}
            domainsReady={domainsReady}
            onSelect={scrollToSection}
          />
        </div>
      )}
      <SetupRestart setup={setup} />
    </SettingsPanel>
  );
}
