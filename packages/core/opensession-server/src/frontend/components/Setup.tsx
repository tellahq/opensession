import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useSetupStatus } from "../hooks/useSetupStatus";
import { DEFAULT_DOC_TITLE, docTitle } from "../lib/brand";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { duration, ease } from "../ui/motion";
import {
  SettingCard,
  SettingsHeader,
  SettingsHint,
  SettingsPanel,
} from "../ui/settings";
import { LoadingState } from "../ui/state";
import { EngineRow, SetupChecklist } from "./SetupChecklist";
import { IdentityCard } from "./SetupIdentity";
import { GithubAccounts } from "./Connections";
import { ReposSection } from "./SetupRepos";
import {
  ClaudeAccountsSection,
  CodexAccountsSection,
} from "./settings/ModelAccounts";
import { ModelProvidersPanel } from "./ModelProviders";
import { ModelDefaultsSection } from "./Models";
import { IconArrowUpRight, IconChevronLeft, IconGlobe } from "./icons";
import {
  chipDotColor,
  integrationState,
  publicUrlState,
  type ChipTone,
  type SetupStatus,
  type SetupStepId,
} from "./setup-shared";

// Settings → Setup: bringing a fresh instance up, one step at a time. On a
// first run nothing else in the UI says what an instance needs — an engine
// that can run a turn, a private address, GitHub, and repos to work in, so
// this walks through them in that order and ends on a review of what's still
// missing.
//
// Every in-app step is also a settings page of its own, rendered from these
// same components:
// the wizard is for the first hour, the pages are for the next year. Nothing
// here is a second implementation of a setting — a step is a heading, a
// sentence, and the same section the settings page shows.

interface StepDef {
  id: SetupStepId;
  /** Short label for the step rail. */
  label: string;
  title: string;
  description: React.ReactNode;
}

const STEPS: StepDef[] = [
  {
    id: "server",
    label: "Server",
    title: "Server access",
    description:
      "Keep the instance private and make it reachable from your devices.",
  },
  {
    id: "github",
    label: "GitHub",
    title: "Connect GitHub",
    description: "Give sessions access to repositories and pull requests.",
  },
  {
    id: "identity",
    label: "Identity",
    title: "Name your instance",
    description:
      "Choose the names this instance and its agent use when they introduce themselves.",
  },
  {
    id: "engine",
    label: "AI",
    title: "Choose your AI",
    description:
      "Connect Claude, OpenAI Codex, or another provider with an API key.",
  },
  {
    id: "repos",
    label: "Repositories",
    title: "Add repositories",
    description: "Register the repositories sessions can work in.",
  },
  {
    id: "review",
    label: "Review",
    title: "Start your first session",
    description: "Review what is ready, then return to Open Session.",
  },
];

/** A step's state for the rail, or null when the step has nothing to report
 *  (identity always has a value; review is a summary of the others). */
function stepTone(id: SetupStepId, status: SetupStatus): ChipTone | null {
  switch (id) {
    case "server":
      return publicUrlState(status.publicBaseUrl).tone;
    case "github": {
      const github = status.integrations.find(
        (integration) => integration.id === "github",
      );
      return github && integrationState(github).tone === "on" ? "on" : "warn";
    }
    case "engine":
      return status.engine.ready ? "on" : "warn";
    case "repos":
      return status.repos.length > 0 ? "on" : "warn";
    default:
      return null;
  }
}

/** The step rail: every step, its state, and a way straight to it. It doubles
 *  as the progress indicator — a wizard that hides where you are in it is
 *  just a form with extra clicks. */
function StepRail({
  current,
  status,
  onSelect,
  className,
}: {
  current: number;
  status: SetupStatus;
  onSelect: (index: number) => void;
  className?: string;
}) {
  return (
    <nav
      aria-label="Setup steps"
      className={cn(
        "flex min-w-0 items-center justify-center gap-1",
        className,
      )}
    >
      {STEPS.map((step, i) => {
        const tone = stepTone(step.id, status);
        const active = i === current;
        return (
          <button
            key={step.id}
            type="button"
            aria-current={active ? "step" : undefined}
            onClick={() => onSelect(i)}
            className={cn(
              "focus-ring flex min-h-9 items-center gap-1.5 rounded-control px-2 text-label transition-colors phone:gap-1 phone:px-1 phone:text-meta",
              active
                ? "bg-selected font-medium text-fg"
                : "text-dim hover:bg-hover hover:text-fg",
            )}
          >
						<span
							className={cn(
								"h-1.5 w-1.5 shrink-0 rounded-full",
								!tone && !active && "border border-current opacity-40",
							)}
							style={
								tone
									? { background: chipDotColor(tone) }
									: active
										? { background: chipDotColor("warn") }
										: undefined
							}
						/>
            {step.label}
            {tone && (
              <span className="sr-only">
                ,{" "}
                {tone === "on"
                  ? "ready"
                  : tone === "warn"
                    ? "needs setup"
                    : "optional"}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

export function SetupPanel({
  onDone,
  onOpenOnboarding,
}: {
  onDone?: () => void;
  onOpenOnboarding: () => void;
}) {
  const setup = useSetupStatus();
  const { status, failed, refetch } = setup;
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [aiRevision, setAiRevision] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    document.title = docTitle("Setup");
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, []);

  useEffect(() => {
    if (index > 0) headingRef.current?.focus({ preventScroll: true });
  }, [index]);

  const step = STEPS[index]!;
  const last = index === STEPS.length - 1;
  const stepMotion = {
    initial: (travel: number) => ({
      opacity: 0,
      x: reducedMotion ? 0 : travel * 28,
    }),
    animate: { opacity: 1, x: 0 },
    exit: (travel: number) => ({
      opacity: 0,
      x: reducedMotion ? 0 : travel * -18,
    }),
  };

  function goTo(next: number) {
    const nextIndex = Math.min(Math.max(next, 0), STEPS.length - 1);
    if (nextIndex === index) return;
    setDirection(nextIndex > index ? 1 : -1);
    setIndex(nextIndex);
    // A step change is a page change: start it at the top, the way the
    // settings pages these steps mirror open.
    document.querySelector("[data-settings-scroll]")?.scrollTo({
      top: 0,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    void refetch();
  }

  async function refreshAi() {
    setAiRevision((revision) => revision + 1);
    await refetch();
  }

  function jumpTo(id: SetupStepId) {
    const i = STEPS.findIndex((s) => s.id === id);
    if (i >= 0) goTo(i);
  }

  return (
		<SettingsPanel className="relative flex max-w-[940px] flex-col overflow-x-clip desktop:h-[calc(100dvh-96px)] desktop:min-h-[640px] desktop:max-h-[760px] [&_input]:phone:text-input-phone">
      <SettingsHeader
        title="Workspace setup"
        className="mb-8"
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
        <>
					<div className="relative min-h-0 flex-1">
            <AnimatePresence
              initial={false}
              mode="popLayout"
              custom={direction}
            >
							<motion.div
								key={step.id}
								data-setup-step={step.id}
                custom={direction}
                variants={stepMotion}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{
                  type: "tween",
                  duration: reducedMotion ? duration.micro : duration.large,
                  ease,
                }}
								className="grid items-start gap-8 px-5 desktop:h-full desktop:grid-cols-[minmax(200px,0.72fr)_minmax(420px,1.28fr)] desktop:gap-14"
              >
                <div className="desktop:pt-4">
                  <p className="m-0 mb-2 text-meta font-semibold text-faint">
                    Step {index + 1}
                  </p>
                  <h2
                    ref={headingRef}
                    tabIndex={-1}
                    className="m-0 text-page-title font-title tracking-[-0.02em] text-fg outline-none"
                  >
                    {step.title}
                  </h2>
                  <p className="m-0 mt-2 max-w-[30ch] text-body leading-relaxed text-dim">
                    {step.description}
                  </p>
                </div>

								<div className="min-w-0 desktop:max-h-full desktop:overflow-y-auto desktop:pr-2 desktop:[scrollbar-width:thin]">
                  {step.id === "server" && (
                    <>
                      <SettingCard>
                        <div className="flex items-start gap-3 px-5 py-4">
                          <IconGlobe
                            size={22}
                            className="mt-0.5 shrink-0 text-dim"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-row-title font-medium text-fg">
                              Private server setup
                            </div>
                            <p className="m-0 mt-1 text-supporting leading-relaxed text-dim">
                              Create a VPS, connect it through Tailscale, and
                              install Open Session.
                            </p>
                            <a
                              href="https://opensession.com/setup"
                              target="_blank"
                              rel="noreferrer"
                              className="mt-3 inline-flex items-center gap-1.5 text-label font-medium text-blue hover:underline"
                            >
                              Set up a server <IconArrowUpRight size={16} />
                            </a>
                          </div>
                        </div>
                      </SettingCard>
                      <SettingsHint>
                        This instance currently opens at {status.publicBaseUrl}.
                        Keep ports 3848 and 3850 closed to the public internet.
                      </SettingsHint>
                    </>
                  )}
                  {step.id === "github" && (
                    <GithubAccounts onChanged={refetch} />
                  )}
                  {step.id === "engine" && (
                    <>
                      <SettingCard>
                        <EngineRow engine={status.engine} onChanged={refetch} />
                      </SettingCard>
                      <ClaudeAccountsSection compact onChanged={refreshAi} />
                      <CodexAccountsSection compact onChanged={refreshAi} />
                      <ModelProvidersPanel />
                      <ModelDefaultsSection key={aiRevision} />
                    </>
                  )}
                  {step.id === "identity" && <IdentityCard />}
                  {step.id === "repos" && (
                    <ReposSection repos={status.repos} onChanged={refetch} />
                  )}
                  {step.id === "review" && (
                    <SetupChecklist
                      status={status}
                      onChanged={refetch}
                      onJump={jumpTo}
                    />
                  )}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>

					<div className="mt-auto grid grid-cols-[1fr_auto_1fr] items-center gap-x-3 gap-y-3 px-5 pt-6 phone:grid-cols-2">
            <Button
              variant="ghost"
              onClick={() => goTo(index - 1)}
              disabled={index === 0}
              icon={<IconChevronLeft size={18} />}
              className={cn("justify-self-start", index === 0 && "invisible")}
            >
              Back
            </Button>
            <StepRail
              current={index}
              status={status}
              onSelect={goTo}
              className="phone:col-span-2 phone:row-start-1"
            />
            {last ? (
              <Button
                variant="primary"
                onClick={onDone}
                disabled={!onDone}
                className="justify-self-end"
              >
                Start a session
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => goTo(index + 1)}
                className="justify-self-end"
              >
                Next
              </Button>
            )}
          </div>
        </>
      )}
    </SettingsPanel>
  );
}
