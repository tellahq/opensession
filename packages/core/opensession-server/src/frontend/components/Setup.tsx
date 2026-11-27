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
      className="mt-10 desktop:sticky desktop:top-0 desktop:col-start-2 desktop:row-start-1 desktop:mt-0"
    >
      <h2
        id="setup-summary-title"
        className="m-0 mb-2 px-4 text-label font-semibold text-faint"
      >
        Summary
      </h2>
      <SettingCard>
        {steps.map((step) => (
          <button
            key={step.id}
            type="button"
            onClick={() => onSelect(step.id)}
            className="focus-ring flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-left hover:bg-hover"
          >
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full",
                step.complete
                  ? "bg-green-soft text-green"
                  : "bg-hover text-faint",
              )}
              aria-hidden="true"
            >
              <IconCheck size={20} />
            </span>
            <span
              className={cn(
                "min-w-0 text-label",
                step.complete ? "font-medium text-fg" : "text-dim",
              )}
            >
              {step.label}
            </span>
            <span className="sr-only">
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
    <section id={sectionAnchor(id)} className={cn("scroll-mt-4", className)}>
      <div className="mb-3 px-5">
        <h2 className="m-0 text-section-title font-title tracking-[-0.015em] text-fg">
          {title}
        </h2>
        <p className="m-0 mt-1.5 max-w-[62ch] text-supporting leading-relaxed text-dim">
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
    <SettingsPanel className="relative max-w-[980px] [&_input]:phone:text-input-phone">
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
        <div className="grid items-start desktop:grid-cols-[minmax(0,720px)_220px] desktop:gap-10">
          <div className="min-w-0 desktop:col-start-1 desktop:row-start-1">
            <SetupPageSection
              id="github"
              title="Connect GitHub"
              description="The GitHub App controls repository access. PR automation is optional."
              className="mt-0"
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
