import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { BASE_PATH } from "../lib/base";
import { PHONE_QUERY } from "../lib/breakpoints";
import { facepileAvatarStyle } from "../lib/presence";
import { DEFAULT_DOC_TITLE, PRODUCT_NAME } from "../lib/brand";
import { useSetupStatus } from "../hooks/useSetupStatus";
import { copyToClipboard } from "../lib/share-link";
import { effectiveTheme, onThemeChanged } from "../lib/theme";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { duration, ease } from "../ui/motion";
import { SettingCardSkeleton } from "../ui/settings";
import { LoadingState } from "../ui/state";
import { BrandMark } from "./BrandTile";
import { GithubAccounts } from "./Connections";
import { RepoTile } from "./RepoTile";
import { GithubAuthCard } from "./SetupIntegrations";
import { ReposSection } from "./SetupRepos";
import { SetupRestart } from "./SetupRestart";
import { UserAvatar } from "./UserAvatar";
import { OrganizationProfileSection } from "./settings/GeneralPanel";
import { ProviderAccountsSection } from "./settings/ModelAccounts";
import { IconCheck, IconGlobe, IconLink } from "./icons";
import { githubAuthState, type SetupStatus } from "./setup-shared";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgBg65: {
    backgroundColor: "color-mix(in oklab, var(--bg) 65%, transparent)",
  },
  py1: {
    paddingBlock: "4px",
  },
  pr2: {
    paddingRight: "calc(4px * 2)",
  },
  pl1: {
    paddingLeft: "4px",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  size6: {
    width: "calc(4px * 6)",
    height: "calc(4px * 6)",
  },
  shrink0: {
    flexShrink: "0",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  bgBg85: {
    backgroundColor: "color-mix(in oklab, var(--bg) 85%, transparent)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  relative: {
    position: "relative",
  },
  absolute: {
    position: "absolute",
  },
  Right05: {
    right: "calc(4px * -0.5)",
  },
  Bottom05: {
    bottom: "calc(4px * -0.5)",
  },
  size25: {
    width: "calc(4px * 2.5)",
    height: "calc(4px * 2.5)",
  },
  bgFg: {
    backgroundColor: "var(--text)",
  },
  textBg: {
    color: "var(--bg)",
  },
  size7: {
    width: "calc(4px * 7)",
    height: "calc(4px * 7)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  grid: {
    display: "grid",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  desktopGridColsRepeatAutoFit200px: {
    "@media (min-width: 721px)": {
      gridTemplateColumns: "repeat(auto-fit,200px)",
    },
  },
  phoneGridCols2: {
    "@media (max-width: 720px)": {
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    },
  },
  phoneGap3: {
    "@media (max-width: 720px)": {
      gap: "calc(4px * 3)",
    },
  },
  minW0: {
    minWidth: "0",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  size2: {
    width: "calc(4px * 2)",
    height: "calc(4px * 2)",
  },
  bgCurrent: {
    backgroundColor: "currentcolor",
  },
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  minH10: {
    minHeight: "calc(4px * 10)",
  },
  wFull: {
    width: "100%",
  },
  px25: {
    paddingInline: "calc(4px * 2.5)",
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  mt1: {
    marginTop: "4px",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  h100dvh: {
    height: "100dvh",
  },
  gridRows44pxMinmax01fr: {
    gridTemplateRows: "44px minmax(0,1fr)",
  },
  gapY3: {
    rowGap: "calc(4px * 3)",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  bgCover: {
    backgroundSize: "cover",
  },
  bgCenter: {
    backgroundPosition: "center",
  },
  p6: {
    padding: "calc(4px * 6)",
  },
  phoneGapY0: {
    "@media (max-width: 720px)": {
      rowGap: "0",
    },
  },
  phonePx0: {
    "@media (max-width: 720px)": {
      paddingInline: "0",
    },
  },
  phonePb0: {
    "@media (max-width: 720px)": {
      paddingBottom: "0",
    },
  },
  phonePtMax12pxEnvSafeAreaInsetTop: {
    "@media (max-width: 720px)": {
      paddingTop: "max(12px, env(safe-area-inset-top))",
    },
  },
  z20: {
    zIndex: "20",
  },
  h11: {
    height: "calc(4px * 11)",
  },
  h10: {
    height: "calc(4px * 10)",
  },
  w8: {
    width: "calc(4px * 8)",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  phoneH11: {
    "@media (max-width: 720px)": {
      height: "calc(4px * 11)",
    },
  },
  phoneW9: {
    "@media (max-width: 720px)": {
      width: "calc(4px * 9)",
    },
  },
  minH40: {
    minHeight: "calc(4px * 40)",
  },
  maxW560px: {
    maxWidth: "560px",
  },
  selfCenter: {
    alignSelf: "center",
  },
  justifySelfCenter: {
    justifySelf: "center",
  },
  roundedSection: {
    borderRadius: "calc(28px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgPaletteGlass: {
    backgroundColor: "var(--palette-glass)",
  },
  px8: {
    paddingInline: "calc(4px * 8)",
  },
  py12: {
    paddingBlock: "calc(4px * 12)",
  },
  BackdropFilterVarPopupBlur: {
    backdropFilter: "var(--popup-blur)",
  },
  smoothShadowRingLg: {
    boxShadow:
      "0 4px 12px -4px color-mix(in srgb, var(--smooth-shadow-color) 5%, transparent), 0 18px 48px -14px color-mix(in srgb, var(--smooth-shadow-color) 11%, transparent), 0 0 0 var(--smooth-ring-width, 1px) color-mix(in srgb, var(--smooth-ring-color) 50%, transparent)",
  },
  px10: {
    paddingInline: "calc(4px * 10)",
  },
  pb2: {
    paddingBottom: "calc(4px * 2)",
  },
  pt9: {
    paddingTop: "calc(4px * 9)",
  },
  textCenter: {
    textAlign: "center",
  },
  phonePx5: {
    "@media (max-width: 720px)": {
      paddingInline: "calc(4px * 5)",
    },
  },
  phonePt6: {
    "@media (max-width: 720px)": {
      paddingTop: "calc(4px * 6)",
    },
  },
  mxAuto: {
    marginInline: "auto",
  },
  mb7: {
    marginBottom: "calc(4px * 7)",
  },
  size16: {
    width: "calc(4px * 16)",
    height: "calc(4px * 16)",
  },
  FilterDropShadow018px28pxRgba000016: {
    filter: "drop-shadow(0 18px 28px rgba(0,0,0,0.16))",
  },
  phoneMb6: {
    "@media (max-width: 720px)": {
      marginBottom: "calc(4px * 6)",
    },
  },
  m0: {
    margin: "0",
  },
  textBalance: {
    textWrap: "balance",
  },
  fontTitle: {
    fontWeight: "var(--title-weight)",
  },
  leading11: {
    lineHeight: "1.1",
  },
  tracking0012em: {
    letterSpacing: "-0.012em",
  },
  outlineNone: {
    outlineStyle: "none",
  },
  phoneTextSectionTitle: {
    "@media (max-width: 720px)": {
      fontSize: "var(--type-section-title)",
    },
  },
  px9: {
    paddingInline: "calc(4px * 9)",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
});

interface FirstMileStep {
  id:
    | "welcome"
    | "github"
    | "github-account"
    | "organization"
    | "ai"
    | "repos"
    | "ready";
  label: string;
  title: string;
  description: string;
}

type FirstMileStepId = FirstMileStep["id"];

interface PanelSize {
  phase: "measuring" | "animating" | "settled";
  fromStep: FirstMileStepId;
  width: number;
  height: number;
  targetWidth: number;
  maxHeight: number;
  footerHeight: number;
}

const PANEL_MAX_WIDTH: Record<FirstMileStepId, number> = {
  welcome: 560,
  organization: 750,
  ai: 750,
  github: 750,
  "github-account": 750,
  repos: 750,
  ready: 900,
};

// Organization and model setup come first. GitHub App creation no longer
// depends on a public callback origin: the manifest returns its credentials to
// the private app, while Domains and public callbacks stay in Settings. Team
// members are not a step: they join through the invite link on the final page,
// so onboarding stays focused on the server itself.
const STEPS: FirstMileStep[] = [
  {
    id: "welcome",
    label: "Welcome",
    title: `Welcome to ${PRODUCT_NAME}`,
    description: "Set up this server before you start using Open Session.",
  },
  {
    id: "organization",
    label: "Organization",
    title: "Your organization",
    description:
      "Choose how your organization appears to your team in Open Session.",
  },
  {
    id: "ai",
    label: "Models",
    title: "Models",
    description:
      "Connect the AI subscriptions your team will use to run sessions.",
  },
  {
    id: "github",
    label: "GitHub",
    title: "Connect GitHub",
    description:
      "Connect a GitHub App so sessions can access repositories, push changes, and create and review pull requests.",
  },
  {
    id: "github-account",
    label: "Personal GitHub",
    title: "Sign in to GitHub",
    description:
      "Sign in so interactive sessions can open pull requests as you.",
  },
  {
    id: "repos",
    label: "Repositories",
    title: "Repositories",
    description: "Add the repositories you want sessions to work in.",
  },
  {
    id: "ready",
    label: "Ready",
    title: "You’re ready",
    description: "Review your setup before entering Open Session.",
  },
];

function initialFirstMileIndex(): number {
  if (typeof window === "undefined") return 0;
  const stored = window.sessionStorage.getItem("opensession:first-mile-step");
  window.sessionStorage.removeItem("opensession:first-mile-step");
  const requested =
    new URLSearchParams(window.location.search).get("step") || stored;
  if (!requested) return 0;
  const index = STEPS.findIndex((item) => item.id === requested);
  return index < 0 ? 0 : index;
}

/** The GitHub organization this instance is wired to, for the organization
 *  step's defaults. Reads the App's own owner first, then falls back to the
 *  org named in the App-create URL the wizard built. */
function connectedGithubOrganization(status: SetupStatus): string {
  if (status.github.appOrg) return status.github.appOrg;
  try {
    const match = new URL(status.github.appCreateUrl).pathname.match(
      /^\/organizations\/([^/]+)/,
    );
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

function PreviewOverflow({
  count,
  transparent = false,
}: {
  count: number;
  transparent?: boolean;
}) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        utilityClassName(
          "flex size-7 items-center justify-center rounded-full border text-meta font-semibold text-dim",
        ),
        transparent
          ? utilityClassName("border-transparent bg-transparent")
          : utilityClassName("border-line bg-bg/85"),
      )}
    >
      +{count}
    </span>
  );
}

function FirstMileSummary({
  status,
  onSelect,
  inviteCopied,
  onCopyInviteLink,
}: {
  status: SetupStatus;
  onSelect: (step: FirstMileStep["id"]) => void;
  inviteCopied: boolean;
  onCopyInviteLink: () => void;
}) {
  const github = githubAuthState(status.github);
  let serverHost = status.publicBaseUrl;
  try {
    serverHost = new URL(status.publicBaseUrl).host;
  } catch {}
  let githubOrganization = status.github.appOrg || "";
  if (!githubOrganization) {
    try {
      const match = new URL(status.github.appCreateUrl).pathname.match(
        /^\/organizations\/([^/]+)/,
      );
      githubOrganization = match?.[1] ? decodeURIComponent(match[1]) : "";
    } catch {}
  }
  const accountCount =
    status.engine.claudeAccounts + status.engine.codexAccounts;
  const accounts = [
    ...Array.from({ length: status.engine.claudeAccounts }, () => ({
      label: "Claude subscription",
      provider: "claude" as const,
    })),
    ...Array.from({ length: status.engine.codexAccounts }, () => ({
      label: "OpenAI subscription",
      provider: "codex" as const,
    })),
  ];
  const tiles = [
    {
      title: "Server",
      step: null,
      ready: true,
      label: "Online",
      preview: (
        <div
          {...stylex.props(
            sx.flex,
            sx.maxWFull,
            sx.itemsCenter,
            sx.gap15,
            sx.roundedFull,
            sx.bgBg65,
            sx.py1,
            sx.pr2,
            sx.pl1,
            sx.fontMedium,
            sx.textFg,
            typography.meta,
          )}
        >
          <span
            {...stylex.props(
              sx.flex,
              sx.size6,
              sx.shrink0,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.roundedFull,
              sx.bgBg85,
              sx.textDim,
            )}
          >
            <IconGlobe size={15} />
          </span>
          <span {...stylex.props(sx.truncate)}>{serverHost}</span>
        </div>
      ),
    },
    {
      title: "GitHub",
      step: "github" as const,
      ready: github.tone === "on",
      label: github.label,
      preview: (
        <div
          {...stylex.props(
            sx.flex,
            sx.maxWFull,
            sx.itemsCenter,
            sx.gap15,
            sx.roundedFull,
            sx.bgBg65,
            sx.py1,
            sx.pr2,
            sx.pl1,
            sx.fontMedium,
            sx.textFg,
            typography.meta,
          )}
        >
          {githubOrganization ? (
            <span {...stylex.props(sx.relative, sx.flex, sx.size6, sx.shrink0)}>
              <UserAvatar
                name={githubOrganization}
                login={githubOrganization}
                size={24}
                className={mergeStylexOverrideClassName("", sx.roundedFull)}
              />
              <span
                {...mergeStylexProps(
                  "ring-1 ring-bg",
                  sx.absolute,
                  sx.Right05,
                  sx.Bottom05,
                  sx.flex,
                  sx.size25,
                  sx.itemsCenter,
                  sx.justifyCenter,
                  sx.roundedFull,
                  sx.bgFg,
                  sx.textBg,
                )}
              >
                <BrandMark name="github" size={7} />
              </span>
            </span>
          ) : (
            <span
              {...stylex.props(
                sx.flex,
                sx.size6,
                sx.shrink0,
                sx.itemsCenter,
                sx.justifyCenter,
                sx.roundedFull,
                sx.bgFg,
                sx.textBg,
              )}
            >
              <BrandMark name="github" size={15} />
            </span>
          )}
          <span {...stylex.props(sx.truncate)}>
            {githubOrganization || "GitHub"}
          </span>
        </div>
      ),
    },
    {
      title: "AI subscriptions",
      step: "ai" as const,
      ready: status.engine.ready,
      label: `${accountCount} ${accountCount === 1 ? "account" : "accounts"} connected`,
      preview: (
        <div {...mergeStylexProps("-space-x-2", sx.flex)}>
          {accounts.slice(0, 4).map((account, index) => (
            <span
              key={`${account.provider}-${index}`}
              title={account.label}
              {...stylex.props(
                sx.flex,
                sx.size7,
                sx.itemsCenter,
                sx.justifyCenter,
                sx.roundedFull,
                sx.border,
                sx.borderLine,
                sx.bgBg85,
                sx.textFg,
              )}
            >
              <BrandMark name={account.provider} size={15} />
            </span>
          ))}
          <PreviewOverflow count={accounts.length - 4} />
        </div>
      ),
    },
    {
      title: "Repositories",
      step: "repos" as const,
      ready: status.repos.length > 0,
      label:
        status.repos.length > 0 ? `${status.repos.length} added` : "None added",
      preview: (
        <div {...mergeStylexProps("-space-x-2", sx.flex)}>
          {status.repos.slice(0, 4).map((repo) => (
            <span
              key={repo.id}
              title={repo.label}
              {...stylex.props(sx.flex, sx.size7)}
            >
              <RepoTile
                name={repo.id}
                size={28}
                className="ring-1 ring-inset ring-line"
              />
            </span>
          ))}
          <PreviewOverflow count={status.repos.length - 4} />
        </div>
      ),
    },
    {
      title: "Members",
      step: null,
      ready: status.team.count > 0,
      copyInvite: true,
      label:
        status.team.count === 1 ? "1 member" : `${status.team.count} members`,
      preview: (
        <div {...mergeStylexProps("-space-x-2", sx.flex)}>
          {status.team.names.slice(0, 4).map((name, index, shown) => (
            <UserAvatar
              key={name}
              name={name}
              size={28}
              style={facepileAvatarStyle(
                index,
                shown.length,
                "var(--popup-surface)",
              )}
            />
          ))}
          <PreviewOverflow count={status.team.count - 4} transparent />
        </div>
      ),
    },
  ];

  return (
    <div
      {...stylex.props(
        sx.grid,
        sx.justifyCenter,
        sx.gap4,
        sx.desktopGridColsRepeatAutoFit200px,
        sx.phoneGridCols2,
        sx.phoneGap3,
      )}
    >
      {tiles.map((tile) => {
        const className = cn(
          utilityClassName(
            "flex aspect-square min-w-0 flex-col justify-between rounded-2xl bg-popup-glass p-5 text-left [backdrop-filter:var(--popup-blur)] smooth-shadow-sm desktop:size-[200px] phone:p-3.5",
          ),
          tile.step &&
            utilityClassName(
              "focus-ring cursor-pointer transition-[transform,filter] duration-150 hover:brightness-[0.98] active:scale-[0.96] motion-reduce:transform-none",
            ),
        );
        const content = (
          <>
            <div
              {...stylex.props(
                sx.flex,
                sx.minW0,
                sx.itemsStart,
                sx.justifyBetween,
                sx.gap2,
              )}
            >
              <div {...stylex.props(sx.minW0)}>{tile.preview}</div>
              <div
                className={cn(
                  utilityClassName(
                    "flex size-8 shrink-0 items-center justify-center rounded-full",
                  ),
                  tile.ready
                    ? utilityClassName("bg-blue text-white")
                    : utilityClassName("bg-faint/10 text-faint"),
                )}
              >
                {tile.ready ? (
                  <IconCheck size={18} />
                ) : (
                  <span
                    {...stylex.props(sx.size2, sx.roundedFull, sx.bgCurrent)}
                  />
                )}
              </div>
            </div>
            <div {...stylex.props(sx.minW0)}>
              {"copyInvite" in tile && (
                <Button
                  variant="soft"
                  size="sm"
                  onClick={onCopyInviteLink}
                  icon={
                    inviteCopied ? (
                      <IconCheck size={15} />
                    ) : (
                      <IconLink size={15} />
                    )
                  }
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.mb3,
                    sx.minH10,
                    sx.wFull,
                    sx.px25,
                    sx.phoneMinH11,
                  )}
                >
                  {inviteCopied ? "Invite link copied" : "Copy invite link"}
                </Button>
              )}
              <div
                {...stylex.props(
                  sx.fontSemibold,
                  sx.textFg,
                  typography.itemTitle,
                )}
              >
                {tile.title}
              </div>
              <div
                {...stylex.props(
                  sx.mt1,
                  sx.leadingSnug,
                  sx.textDim,
                  typography.supporting,
                )}
              >
                {tile.label}
              </div>
            </div>
          </>
        );
        return tile.step ? (
          <button
            type="button"
            key={tile.title}
            onClick={() => onSelect(tile.step)}
            aria-label={`Edit ${tile.title}`}
            className={className}
          >
            {content}
          </button>
        ) : (
          <div key={tile.title} className={className}>
            {content}
          </div>
        );
      })}
    </div>
  );
}

export function FirstMile({ onDone }: { onDone: () => Promise<void> }) {
  const setup = useSetupStatus();
  const { status, failed, refetch } = setup;
  const [index, setIndex] = useState(initialFirstMileIndex);
  const [contentVisible, setContentVisible] = useState(true);
  const [navigationVisible, setNavigationVisible] = useState(true);
  const [panelVisible, setPanelVisible] = useState(true);
  const [crossfade, setCrossfade] = useState<{
    target: number;
    phase: "out" | "in";
  } | null>(null);
  const [panelSize, setPanelSize] = useState<PanelSize | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [personalGithubVisited, setPersonalGithubVisited] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [theme, setTheme] = useState(effectiveTheme);
  const rootRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const panelHeaderRef = useRef<HTMLElement>(null);
  const panelScrollRef = useRef<HTMLDivElement>(null);
  const panelScrollContentRef = useRef<HTMLDivElement>(null);
  const panelFooterRef = useRef<HTMLElement>(null);
  const panelResizeFrameRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reducedMotion = useReducedMotion();
  const steps = STEPS;
  const step = steps[index]!;
  const githubIndex = steps.findIndex((item) => item.id === "github");
  const personalGithubIndex = steps.findIndex(
    (item) => item.id === "github-account",
  );
  const repositoriesIndex = steps.findIndex((item) => item.id === "repos");

  useEffect(() => {
    document.title = `Welcome to ${PRODUCT_NAME}`;
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, []);

  useEffect(() => onThemeChanged(() => setTheme(effectiveTheme())), []);

  useEffect(() => {
    const releaseSize = () => {
      window.cancelAnimationFrame(panelResizeFrameRef.current);
      setPanelSize(null);
      setContentVisible(true);
      setNavigationVisible(true);
    };
    window.addEventListener("resize", releaseSize);
    return () => {
      window.cancelAnimationFrame(panelResizeFrameRef.current);
      window.removeEventListener("resize", releaseSize);
    };
  }, []);

  useEffect(() => {
    if (contentVisible && index > 0) {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [contentVisible, index]);

  // The next step mounts invisibly at its final width while the shell keeps
  // the previous step's exact dimensions. Once that layout has settled, the
  // shell receives one width/height target and animates to it. Keeping the
  // settled pixel size for the rest of the step means a late async row can
  // become scrollable, but cannot make the dialog jump a second time.
  useEffect(() => {
    if (panelSize?.phase !== "measuring") return;
    const body = panelBodyRef.current;
    if (!body) {
      setContentVisible(true);
      setNavigationVisible(true);
      setPanelSize(null);
      return;
    }

    let done = false;
    let quietTimer = 0;
    const started = performance.now();
    const unknownContentPending = () =>
      Array.from(body.querySelectorAll('[role="status"]')).some(
        (node) => !node.hasAttribute("aria-label"),
      );
    const finishMeasurement = () => {
      if (done) return;
      done = true;
      window.clearTimeout(quietTimer);
      const footerHeight =
        panelFooterRef.current?.getBoundingClientRect().height ?? 0;
      const targetHeight = Math.min(
        panelSize.maxHeight,
        Math.ceil(body.getBoundingClientRect().height + footerHeight),
      );
      setPanelSize((current) =>
        current?.phase === "measuring"
          ? {
              ...current,
              phase: reducedMotion ? "settled" : "animating",
              width: current.targetWidth,
              height: targetHeight,
            }
          : current,
      );
      setContentVisible(true);
      setNavigationVisible(true);
    };
    const scheduleMeasurement = () => {
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(() => {
        // Loading marks without a reserved shape get a short chance to resolve.
        // Skeletons carry aria-label and already describe their final geometry.
        if (unknownContentPending() && performance.now() - started < 700)
          return;
        finishMeasurement();
      }, 100);
    };
    const observer = new ResizeObserver(scheduleMeasurement);
    observer.observe(body);
    const mutations = new MutationObserver(scheduleMeasurement);
    mutations.observe(body, { childList: true, subtree: true });
    const deadline = window.setTimeout(finishMeasurement, 700);
    scheduleMeasurement();

    return () => {
      done = true;
      window.clearTimeout(quietTimer);
      window.clearTimeout(deadline);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [panelSize?.phase, panelSize?.maxHeight, reducedMotion]);

  useEffect(() => {
    if (panelSize?.phase !== "animating") return;
    const timer = window.setTimeout(() => {
      setPanelSize((current) =>
        current?.phase === "animating"
          ? { ...current, phase: "settled" }
          : current,
      );
    }, duration.large * 1000);
    return () => window.clearTimeout(timer);
  }, [panelSize?.phase]);

  function resizePanelForContentChange() {
    const panel = panelRef.current;
    const root = rootRef.current;
    const progress = progressRef.current;
    const header = panelHeaderRef.current;
    const scroll = panelScrollRef.current;
    const scrollContent = panelScrollContentRef.current;
    const footer = panelFooterRef.current;
    if (
      !panel ||
      !root ||
      !progress ||
      !header ||
      !scroll ||
      !scrollContent ||
      !footer ||
      window.matchMedia(PHONE_QUERY).matches ||
      crossfade ||
      panelSize?.phase === "measuring"
    )
      return;

    const panelRect = panel.getBoundingClientRect();
    const rootStyle = window.getComputedStyle(root);
    const maxHeight =
      root.clientHeight -
      parseFloat(rootStyle.paddingTop) -
      parseFloat(rootStyle.paddingBottom) -
      progress.getBoundingClientRect().height -
      (parseFloat(rootStyle.rowGap) || 0);
    const footerHeight = footer.getBoundingClientRect().height;
    setPanelSize({
      phase: "settled",
      fromStep: step.id,
      width: panelRect.width,
      height: panelRect.height,
      targetWidth: panelRect.width,
      maxHeight,
      footerHeight,
    });
    window.cancelAnimationFrame(panelResizeFrameRef.current);
    panelResizeFrameRef.current = window.requestAnimationFrame(() => {
      const scrollStyle = window.getComputedStyle(scroll);
      const contentHeight =
        parseFloat(scrollStyle.paddingTop) +
        scrollContent.getBoundingClientRect().height +
        parseFloat(scrollStyle.paddingBottom);
      const targetHeight = Math.min(
        maxHeight,
        Math.ceil(
          header.getBoundingClientRect().height + contentHeight + footerHeight,
        ),
      );
      setPanelSize((current) =>
        current?.phase === "settled" && current.fromStep === step.id
          ? {
              ...current,
              phase: reducedMotion ? "settled" : "animating",
              height: targetHeight,
            }
          : current,
      );
    });
  }

  function goTo(next: number) {
    const nextIndex = Math.min(Math.max(next, 0), steps.length - 1);
    if (
      nextIndex === index ||
      crossfade ||
      panelSize?.phase === "measuring" ||
      panelSize?.phase === "animating"
    )
      return;
    const nextStep = steps[nextIndex]!;
    const readyCrossfade =
      (step.id === "repos" && nextStep.id === "ready") ||
      (step.id === "ready" && nextStep.id === "repos");
    if (readyCrossfade) {
      setCrossfade({ target: nextIndex, phase: "out" });
      setPanelVisible(false);
      void refetch();
      return;
    }

    const panel = panelRef.current;
    const root = rootRef.current;
    const progress = progressRef.current;
    const phone = window.matchMedia(PHONE_QUERY).matches;
    if (!panel || !root || !progress || phone) {
      setPanelSize(null);
      setIndex(nextIndex);
      void refetch();
      return;
    }

    const panelRect = panel.getBoundingClientRect();
    const rootStyle = window.getComputedStyle(root);
    const horizontalPadding =
      parseFloat(rootStyle.paddingLeft) + parseFloat(rootStyle.paddingRight);
    const verticalPadding =
      parseFloat(rootStyle.paddingTop) + parseFloat(rootStyle.paddingBottom);
    const rowGap = parseFloat(rootStyle.rowGap) || 0;
    setPanelSize({
      phase: "measuring",
      fromStep: step.id,
      width: panelRect.width,
      height: panelRect.height,
      targetWidth: Math.min(
        PANEL_MAX_WIDTH[nextStep.id],
        root.clientWidth - horizontalPadding,
      ),
      maxHeight:
        root.clientHeight -
        verticalPadding -
        progress.getBoundingClientRect().height -
        rowGap,
      footerHeight: panelFooterRef.current?.getBoundingClientRect().height ?? 0,
    });
    setContentVisible(false);
    setIndex(nextIndex);
    void refetch();
  }

  function finishPanelCrossfade() {
    if (!crossfade) return;
    if (crossfade.phase === "out") {
      setIndex(crossfade.target);
      setPanelSize(null);
      setCrossfade({ ...crossfade, phase: "in" });
      setPanelVisible(true);
      return;
    }
    setCrossfade(null);
  }

  function openPersonalGithub() {
    setPersonalGithubVisited(true);
    void goTo(personalGithubIndex);
  }

  function goBack() {
    if (step.id === "repos") {
      void goTo(personalGithubVisited ? personalGithubIndex : githubIndex);
      return;
    }
    void goTo(index - 1);
  }

  function goForward() {
    if (step.id === "ready") {
      void finish();
      return;
    }
    if (step.id === "github") {
      setPersonalGithubVisited(false);
      void goTo(repositoriesIndex);
      return;
    }
    if (step.id === "github-account") {
      setPersonalGithubVisited(true);
      void goTo(repositoriesIndex);
      return;
    }
    void goTo(index + 1);
  }

  async function finish() {
    if (finishing) return;
    setNavigationVisible(false);
    setFinishing(true);
    await onDone();
    setFinishing(false);
    setNavigationVisible(true);
  }

  // The invite link is just this server's address: anyone on the network signs
  // in with GitHub, so there is nothing more to mint or provision.
  function copyInviteLink() {
    copyToClipboard(`${window.location.origin}${BASE_PATH}/`, () => {
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2000);
    });
  }

  const backdropName =
    theme === "dark" ? "onboarding-bg-dark" : "onboarding-bg";
  const nextLabel =
    index === 0
      ? "Setup server"
      : index === steps.length - 1
        ? finishing
          ? "Finishing…"
          : null
        : index === steps.length - 2
          ? "Review"
          : "Next";

  const panelTransitioning =
    !!crossfade ||
    panelSize?.phase === "measuring" ||
    panelSize?.phase === "animating";
  const surfaceStep =
    panelSize?.phase === "measuring" ? panelSize.fromStep : step.id;
  const edgeSurface = surfaceStep === "welcome" || surfaceStep === "ready";
  const stagedPanel =
    panelSize?.phase === "measuring" || panelSize?.phase === "animating";

  return (
    <div
      ref={rootRef}
      data-first-mile
      {...stylex.props(
        sx.relative,
        sx.grid,
        sx.h100dvh,
        sx.wFull,
        sx.gridRows44pxMinmax01fr,
        sx.gapY3,
        sx.overflowHidden,
        sx.bgSurface,
        sx.bgCover,
        sx.bgCenter,
        sx.p6,
        sx.textFg,
        sx.phoneGapY0,
        sx.phonePx0,
        sx.phonePb0,
        sx.phonePtMax12pxEnvSafeAreaInsetTop,
      )}
      // The vendored marketing artwork keeps first run independent of a CDN.
      style={{ backgroundImage: `url(${BASE_PATH}/${backdropName}.webp)` }}
    >
      <nav
        ref={progressRef}
        aria-label="Onboarding progress"
        // This top row doubles as the Electron window drag region; base.css
        // carves its step buttons back out so they remain clickable.
        {...mergeStylexProps(
          "wco-chrome",
          sx.relative,
          sx.z20,
          sx.flex,
          sx.h11,
          sx.shrink0,
          sx.itemsStart,
          sx.justifyCenter,
        )}
      >
        {steps.map((item, stepIndex) => (
          <button
            key={item.id}
            type="button"
            disabled={panelTransitioning}
            onClick={() => {
              if (item.id === "github-account") setPersonalGithubVisited(true);
              goTo(stepIndex);
            }}
            aria-label={`${item.label}, step ${stepIndex + 1} of ${steps.length}`}
            aria-current={stepIndex === index ? "step" : undefined}
            {...mergeStylexProps(
              "group focus-ring",
              sx.flex,
              sx.h10,
              sx.w8,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.roundedControl,
              sx.phoneH11,
              sx.phoneW9,
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                utilityClassName(
                  "h-2 rounded-full transition-[width,background-color,opacity] duration-[var(--dur)] ease-[var(--ease)] motion-reduce:transition-none",
                ),
                stepIndex === index
                  ? utilityClassName("w-6 bg-fg")
                  : stepIndex < index
                    ? utilityClassName("w-2 bg-fg/45 group-hover:bg-fg/65")
                    : utilityClassName(
                        "w-2 bg-faint/35 group-hover:bg-faint/60",
                      ),
              )}
            />
          </button>
        ))}
      </nav>

      {!status ? (
        <div
          {...mergeStylexProps(
            "[--smooth-ring-color:var(--dialog-ring)]",
            sx.flex,
            sx.minH40,
            sx.wFull,
            sx.maxW560px,
            sx.selfCenter,
            sx.justifySelfCenter,
            sx.itemsCenter,
            sx.justifyCenter,
            sx.roundedSection,
            sx.bgPaletteGlass,
            sx.px8,
            sx.py12,
            sx.BackdropFilterVarPopupBlur,
            sx.smoothShadowRingLg,
          )}
        >
          <LoadingState>
            {failed ? "Couldn't load setup." : "Preparing your workspace…"}
          </LoadingState>
        </div>
      ) : (
        <motion.section
          ref={panelRef}
          initial={false}
          animate={{ opacity: panelVisible ? 1 : 0 }}
          transition={{ type: "tween", duration: duration.micro, ease }}
          onAnimationComplete={finishPanelCrossfade}
          className={cn(
            utilityClassName(
              "relative z-10 flex max-h-full w-full self-center justify-self-center flex-col overflow-hidden rounded-section phone:h-full phone:max-h-none phone:max-w-none phone:self-stretch phone:rounded-none phone:[box-shadow:none]",
            ),
            panelSize
              ? utilityClassName("max-w-none")
              : step.id === "ready"
                ? utilityClassName("max-w-[900px]")
                : step.id === "welcome"
                  ? utilityClassName("max-w-[560px]")
                  : utilityClassName("max-w-[750px]"),
            edgeSurface
              ? utilityClassName("bg-transparent [backdrop-filter:none]")
              : utilityClassName(
                  "bg-palette-glass [--smooth-ring-color:var(--dialog-ring)] [backdrop-filter:var(--popup-blur)] smooth-shadow-ring-lg",
                ),
            panelSize?.phase === "animating" &&
              utilityClassName(
                "transition-[width,height] duration-[var(--dur-lg)] ease-[var(--ease)] motion-reduce:transition-none",
              ),
          )}
          style={
            panelSize
              ? { width: panelSize.width, height: panelSize.height }
              : undefined
          }
        >
          <div
            ref={panelBodyRef}
            className={cn(
              utilityClassName("flex min-h-0 max-h-full flex-col"),
              stagedPanel
                ? utilityClassName("absolute top-0 left-1/2 -translate-x-1/2")
                : utilityClassName("w-full flex-1"),
            )}
            style={
              stagedPanel
                ? {
                    width: panelSize.targetWidth,
                    maxHeight: panelSize.maxHeight - panelSize.footerHeight,
                  }
                : undefined
            }
          >
            <div
              key={step.id}
              aria-hidden={!contentVisible}
              inert={!contentVisible}
              className={cn(
                utilityClassName(
                  "flex min-h-0 flex-1 flex-col transition-opacity duration-[var(--dur-micro)] ease-[var(--ease)] motion-reduce:transition-none",
                ),
                !contentVisible && utilityClassName("opacity-0"),
              )}
            >
              <header
                ref={panelHeaderRef}
                {...stylex.props(
                  sx.shrink0,
                  sx.px10,
                  sx.pb2,
                  sx.pt9,
                  sx.textCenter,
                  sx.phonePx5,
                  sx.phonePt6,
                )}
              >
                {step.id === "welcome" && (
                  <img
                    src={`${BASE_PATH}/mac-app-icon.png`}
                    alt=""
                    {...stylex.props(
                      sx.mxAuto,
                      sx.mb7,
                      sx.size16,
                      sx.FilterDropShadow018px28pxRgba000016,
                      sx.phoneMb6,
                    )}
                  />
                )}
                <h1
                  ref={headingRef}
                  tabIndex={index > 0 ? -1 : undefined}
                  {...stylex.props(
                    sx.m0,
                    sx.textBalance,
                    sx.fontTitle,
                    sx.leading11,
                    sx.tracking0012em,
                    sx.textFg,
                    sx.outlineNone,
                    sx.phoneTextSectionTitle,
                    typography.pageTitle,
                  )}
                >
                  {step.title}
                </h1>
              </header>

              <div
                ref={panelScrollRef}
                className={cn(
                  utilityClassName("min-h-0"),
                  step.id === "welcome"
                    ? utilityClassName("h-4 shrink-0")
                    : utilityClassName(
                        "flex-1 overflow-y-auto overscroll-contain px-10 pb-12 pt-5 [-webkit-mask-image:linear-gradient(to_bottom,#000_0,#000_calc(100%_-_36px),transparent_100%)] [mask-image:linear-gradient(to_bottom,#000_0,#000_calc(100%_-_36px),transparent_100%)] [scrollbar-width:thin] phone:px-4 phone:pb-12 phone:pt-4",
                      ),
                )}
              >
                {step.id !== "welcome" && (
                  <div
                    ref={panelScrollContentRef}
                    className={cn(
                      utilityClassName(
                        "mx-auto w-full [&_[data-setting-title]]:text-dialog-title [&_[data-setting-title]]:phone:text-body [&_[data-settings-group-label]]:text-body [&_[data-settings-group-label]]:text-fg [&_[data-settings-hint]]:leading-[1.5] [&_[data-settings-hint]]:text-faint [&_[data-onboarding-caption]]:leading-[1.5]",
                      ),
                      step.id === "ready"
                        ? utilityClassName("max-w-[1160px]")
                        : utilityClassName("max-w-[780px]"),
                      step.id !== "github-account" &&
                        "[&_.bg-settings-plate:not(.personal-github-card)]:border-0 [&_.bg-settings-plate:not(.personal-github-card)]:bg-transparent! [&_.bg-settings-plate:not(.personal-github-card)]:shadow-none [&_.bg-settings-plate:not(.personal-github-card)]:[backdrop-filter:none]",
                      "[&_input]:h-9 [&_input]:min-h-9 [&_input]:px-3 [&_input]:text-base [&_select]:min-h-9 [&_textarea]:min-h-9",
                    )}
                  >
                    {step.id === "github" && (
                      <GithubAuthCard
                        github={status.github}
                        onSaved={setup.applyGithub}
                        onboarding
                        onPersonalSignIn={openPersonalGithub}
                        onContentSizeChange={resizePanelForContentChange}
                      />
                    )}
                    {step.id === "github-account" && (
                      <div {...stylex.props(sx.wFull, sx.px9, sx.phonePx5)}>
                        <GithubAccounts
                          personal
                          showHeading={false}
                          showHint={false}
                          cancelOutside
                          cardClassName={utilityClassName(
                            "border-line! bg-button! smooth-shadow-xs",
                          )}
                          onContentSizeChange={resizePanelForContentChange}
                          loadingFallback={
                            <SettingCardSkeleton
                              rows={1}
                              icon={30}
                              label="Loading GitHub account"
                              className="[&_.bg-settings-plate]:min-h-[72px] [&_.bg-settings-plate]:border-line! [&_.bg-settings-plate]:bg-button!"
                            />
                          }
                        />
                      </div>
                    )}
                    {step.id === "organization" && (
                      <OrganizationProfileSection
                        githubOrganization={connectedGithubOrganization(status)}
                        onboarding
                      />
                    )}
                    {step.id === "ai" && (
                      <ProviderAccountsSection onboarding onChanged={refetch} />
                    )}
                    {step.id === "repos" && (
                      <ReposSection
                        repos={status.repos}
                        onChanged={refetch}
                        compact
                        showLifecycleStatus={false}
                      />
                    )}
                    {step.id === "ready" && (
                      <FirstMileSummary
                        status={status}
                        onSelect={(stepId) =>
                          goTo(steps.findIndex((item) => item.id === stepId))
                        }
                        inviteCopied={inviteCopied}
                        onCopyInviteLink={copyInviteLink}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <motion.footer
            ref={panelFooterRef}
            initial={false}
            animate={{ opacity: navigationVisible ? 1 : 0 }}
            transition={{ type: "tween", duration: duration.micro, ease }}
            aria-hidden={!navigationVisible}
            inert={!navigationVisible}
            className={cn(
              utilityClassName(
                "relative z-20 mt-auto shrink-0 px-6 pb-5 pt-4 phone:px-3 phone:pb-[max(12px,env(safe-area-inset-bottom))] phone:pt-3",
              ),
              !navigationVisible && utilityClassName("pointer-events-none"),
            )}
          >
            <div
              className={cn(
                utilityClassName("flex items-center gap-3"),
                index === 0 || step.id === "ready"
                  ? utilityClassName("justify-center")
                  : utilityClassName("justify-between"),
              )}
            >
              {index > 0 && step.id !== "ready" && (
                <Button
                  variant="soft"
                  size="lg"
                  onClick={goBack}
                  className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
                >
                  Back
                </Button>
              )}

              <Button
                variant="primary"
                size="lg"
                onClick={goForward}
                disabled={finishing}
                className={mergeStylexOverrideClassName(
                  "",
                  sx.px4,
                  sx.phoneMinH11,
                )}
              >
                {nextLabel ?? `Enter ${PRODUCT_NAME}`}
              </Button>
            </div>
          </motion.footer>
        </motion.section>
      )}

      <SetupRestart setup={setup} />
    </div>
  );
}
