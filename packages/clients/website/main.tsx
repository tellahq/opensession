import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createRoot } from "react-dom/client";
import markAsset from "../mac/build/icon-512.png";
import downloadMacAsset from "./download-mac.webp";
import downloadPhoneAsset from "./download-phone.webp";
import {
  IconArrowUpRight,
  IconBell,
  IconBranches,
  IconCheck,
  IconClock,
  IconCopy,
  IconGlobe,
  IconPeople,
  IconPhone,
  IconPullRequest,
  IconRepo,
  IconRobot,
  IconServer,
  IconSparkle,
  IconStack,
  IconTerminal,
  IconX,
} from "../../core/opensession-server/src/frontend/components/icons";
import "./site.css";
import "./landing-glass.css";
import { AgentationFeedback } from "./AgentationFeedback";
import { AnnouncementArticle } from "./AnnouncementArticle";
import { ProductDemo } from "./ProductDemo";
import { assetUrl } from "./asset-url";

const markUrl = assetUrl(markAsset);
const downloadMacUrl = assetUrl(downloadMacAsset);
const downloadPhoneUrl = assetUrl(downloadPhoneAsset);
const macDownloadUrl =
  "https://github.com/tellahq/opensession/releases/latest/download/OpenSession-arm64.dmg";
const installCommandLines = [
  "curl -fsSL https://raw.githubusercontent.com",
  "/tellahq/opensession/main/install.sh | bash",
] as const;
const installCommand = installCommandLines.join("");

function Mark() {
  return (
    <span className="mark">
      <img src={markUrl} alt="" />
    </span>
  );
}

function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function AppleMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11Z" />
    </svg>
  );
}

function TailscaleMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M24 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm-9 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm0-9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm6-6a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 24a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm18 .5a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm9-9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm-3 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 3a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM3 5.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
    </svg>
  );
}

/**
 * One cell of the capability grid: a glyph, a name, and what it means. A cell
 * marked `soon` describes something that is not shipped yet, so the tag sits
 * on the name where nobody can read the sentence without it.
 */
function Feature({
  icon,
  name,
  soon,
  children,
}: {
  icon: ReactNode;
  name: string;
  soon?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="feature">
      <span className="feature-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="feature-head">
        <h3>{name}</h3>
        {soon && <span className="feature-soon">Coming soon</span>}
      </div>
      <p>{children}</p>
    </div>
  );
}

function Question({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="faq-item">
      <summary>
        {q}
        <span className="faq-sign" aria-hidden="true" />
      </summary>
      <p>{children}</p>
    </details>
  );
}

/**
 * What the download dialog shows: two cards for what you are installing, and
 * the browser-install steps behind the web card. The site and the app keep
 * their own copies on purpose - this one is plain CSS on the landing page's
 * tokens, the app's is built on its own UI primitives.
 */
function DownloadAppsCards({
  onShowInstallHelp,
}: {
  onShowInstallHelp: () => void;
}) {
  return (
    <div className="download-cards">
      <section className="download-card">
        <div className="download-card-preview download-card-preview-mac">
          <img src={downloadMacUrl} alt="Open Session running on Mac" />
          <span className="download-card-fade" aria-hidden="true" />
        </div>
        <div className="download-card-body">
          <strong>Open Session for Mac</strong>
          <small>Apple silicon</small>
          <a className="download-card-action" href={macDownloadUrl}>
            <AppleMark />
            Download
          </a>
        </div>
      </section>

      <section className="download-card">
        <div className="download-card-preview download-card-preview-phone">
          <img
            src={downloadPhoneUrl}
            alt="Open Session installed as a phone web app"
          />
          <span className="download-card-fade" aria-hidden="true" />
        </div>
        <div className="download-card-body">
          <strong>Web</strong>
          <small>Install as a PWA</small>
          <button
            type="button"
            className="download-card-action download-card-action-soft"
            onClick={onShowInstallHelp}
          >
            How to install
          </button>
        </div>
      </section>
    </div>
  );
}

function WebsiteModal({
  dialogRef,
  className,
  labelledBy,
  closeLabel = "Close",
  onClose,
  onRequestClose,
  autoFocusClose = false,
  children,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  className: string;
  labelledBy: string;
  closeLabel?: string;
  onClose?: () => void;
  onRequestClose?: () => void;
  autoFocusClose?: boolean;
  children: ReactNode;
}) {
  const requestClose = () => {
    if (onRequestClose) onRequestClose();
    else dialogRef.current?.close();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const modals =
        document.querySelectorAll<HTMLDialogElement>("dialog:modal");
      if (modals.item(modals.length - 1) !== dialog) return;
      event.preventDefault();
      event.stopPropagation();
      requestAnimationFrame(() => {
        if (onRequestClose) onRequestClose();
        else dialog.close();
      });
    };
    dialog.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      dialog.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [dialogRef, onRequestClose]);

  return (
    <dialog
      ref={dialogRef}
      className={`website-modal ${className}`}
      aria-labelledby={labelledBy}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="website-modal-panel">
        <button
          type="button"
          className="website-modal-close"
          aria-label={closeLabel}
          autoFocus={autoFocusClose}
          onClick={requestClose}
        >
          <IconX size={22} />
        </button>
        {children}
      </div>
    </dialog>
  );
}

function InstallHelpDialog({
  dialogRef,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
}) {
  return (
    <WebsiteModal
      dialogRef={dialogRef}
      className="pwa-guide setup-guide"
      labelledBy="install-help-title"
      onRequestClose={() => dialogRef.current?.close()}
    >
      <h2 id="install-help-title">Install the web app</h2>
      <div className="download-steps">
        <ol>
          <li>
            <strong>Open in your browser</strong>
            <span>
              Use Safari on iPhone or iPad, or Chrome on Android and desktop.
            </span>
          </li>
          <li>
            <strong>Open the browser menu</strong>
            <span>
              On iPhone or iPad, tap Share. Elsewhere, open the browser menu.
            </span>
          </li>
          <li>
            <strong>Add Open Session</strong>
            <span>Choose Add to Home Screen, Install app, or Add to Dock.</span>
          </li>
        </ol>
      </div>
    </WebsiteModal>
  );
}

function SetupGuide({
  triggerLabel,
  triggerIcon,
  title,
  description,
  secondary = false,
  children,
}: {
  triggerLabel: string;
  triggerIcon?: ReactNode;
  title: string;
  description?: string;
  secondary?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = `setup-guide-${title.toLowerCase().replaceAll(" ", "-")}`;

  return (
    <>
      <button
        type="button"
        className={`landing-setup-step-action${secondary ? " landing-setup-step-action-secondary" : ""}`}
        onClick={() => dialogRef.current?.showModal()}
      >
        {triggerIcon}
        {triggerLabel}
      </button>
      <WebsiteModal
        dialogRef={dialogRef}
        className="pwa-guide setup-guide"
        labelledBy={titleId}
      >
        <h2 id={titleId}>{title}</h2>
        {description && <p>{description}</p>}
        {children}
      </WebsiteModal>
    </>
  );
}

function InstallCommand() {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copyLabel =
    copyState === "copied"
      ? "Copied"
      : copyState === "failed"
        ? "Try again"
        : "Copy";

  return (
    <div className="landing-install-command">
      <code>
        {installCommandLines[0]}
        <wbr />
        {installCommandLines[1]}
      </code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(installCommand);
            setCopyState("copied");
          } catch {
            setCopyState("failed");
          }
        }}
      >
        {copyState === "copied" ? (
          <IconCheck size={16} />
        ) : (
          <IconCopy size={16} />
        )}
        <span aria-live="polite">{copyLabel}</span>
      </button>
    </div>
  );
}

function SetupOverview() {
  const installDialogRef = useRef<HTMLDialogElement>(null);

  return (
    <section className="card landing-setup-overview">
      <h2>Set up is easy</h2>

      <ol className="landing-setup-steps">
        <li>
          <span className="landing-setup-step-icon" aria-hidden="true">
            <IconServer size={22} />
          </span>
          <div className="landing-setup-step-copy">
            <strong>
              <span aria-hidden="true">1. </span>Get a server
            </strong>
            <span>Use a VPS or Mac mini you can leave connected.</span>
          </div>
          <SetupGuide
            triggerLabel="Run installer"
            triggerIcon={<IconTerminal size={20} />}
            title="Install Open Session"
            description="Run one command on Linux, macOS, or WSL2."
            secondary
          >
            <InstallCommand />
          </SetupGuide>
        </li>
        <li>
          <span className="landing-setup-step-icon" aria-hidden="true">
            <IconGlobe size={22} />
          </span>
          <div className="landing-setup-step-copy">
            <strong>
              <span aria-hidden="true">2. </span>Expose it safely
            </strong>
            <span>Connect from your phone or share with your team.</span>
          </div>
          <a
            className="landing-setup-step-action landing-setup-step-action-secondary"
            href="https://tailscale.com/download"
            target="_blank"
            rel="noreferrer"
          >
            <TailscaleMark />
            Install Tailscale
            <IconArrowUpRight size={20} />
          </a>
        </li>
        <li>
          <span className="landing-setup-step-icon" aria-hidden="true">
            <IconPhone size={22} />
          </span>
          <div className="landing-setup-step-copy">
            <strong>
              <span aria-hidden="true">3. </span>Download apps
            </strong>
            <span>Each app connects to the server you just installed.</span>
          </div>
          <SetupGuide
            triggerLabel="Download apps"
            triggerIcon={<AppleMark />}
            title="Download app"
          >
            <DownloadAppsCards
              onShowInstallHelp={() => installDialogRef.current?.showModal()}
            />
          </SetupGuide>
        </li>
      </ol>
      <InstallHelpDialog dialogRef={installDialogRef} />
    </section>
  );
}

function AnnouncementDialog({
  open,
  onRequestClose,
}: {
  open: boolean;
  onRequestClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - root.clientWidth;

    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;

    return () => {
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
      body.style.paddingRight = previousBodyPaddingRight;
    };
  }, [open]);

  return (
    <WebsiteModal
      dialogRef={dialogRef}
      className="announcement-dialog"
      labelledBy="announcement-title"
      closeLabel="Close announcement"
      onRequestClose={onRequestClose}
      autoFocusClose
    >
      <div className="announcement-scroll">
        <AnnouncementArticle />
      </div>
    </WebsiteModal>
  );
}

/**
 * The page: a rail that stays put, and a feed that explains the product one
 * quiet card at a time. The rail holds the whole pitch and its CTAs, so the
 * ask never scrolls away and the feed never has to repeat it.
 */
function LandingPage() {
  const [announcementOpen, setAnnouncementOpen] = useState(false);

  useEffect(() => {
    const syncAnnouncementWithUrl = () => {
      setAnnouncementOpen(window.location.pathname === "/announcement");
    };
    window.addEventListener("popstate", syncAnnouncementWithUrl);
    return () =>
      window.removeEventListener("popstate", syncAnnouncementWithUrl);
  }, []);

  useEffect(() => {
    document.title = announcementOpen
      ? "Introducing Open Session · Open Session"
      : "Open Session · Your team’s control room for coding agents";
  }, [announcementOpen]);

  const openAnnouncement = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    window.history.pushState({ announcementModal: true }, "", "/announcement");
    setAnnouncementOpen(true);
  };

  const closeAnnouncement = () => {
    if (window.location.pathname === "/announcement") {
      window.history.back();
      return;
    }
    setAnnouncementOpen(false);
  };

  return (
    <div className="shell">
      <aside className="rail">
        <a className="brand" href="/" aria-label="Open Session home">
          <Mark />
        </a>

        <h1>
          Your team’s control room <span>for coding agents</span>
        </h1>

        <div className="rail-foot">
          <div className="rail-actions">
            <a
              className="button button-primary"
              href="https://github.com/tellahq/opensession"
            >
              <GitHubMark size={17} />
              View on GitHub
            </a>
            <a
              className="button button-secondary"
              href="/announcement"
              onClick={openAnnouncement}
            >
              <IconBell size={20} />
              Announcement
            </a>
          </div>
          <p className="rail-note">The open-source cloud agent orchestrator</p>
        </div>
      </aside>

      <main className="feed">
        <section className="stage">
          <ProductDemo />
        </section>

        <section className="card feature-card">
          <div className="features">
            <Feature icon={<IconSparkle size={28} />} name="Use any model">
              Bring your own subscription and API keys. Switch models whenever
              you like.
            </Feature>
            <Feature icon={<IconPeople size={28} />} name="Multiplayer">
              Sessions can be shared as links so you can collaborate with your
              team.
            </Feature>
            <Feature icon={<IconGlobe size={28} />} name="Self-host">
              Self-hosted from the first minute. The checkouts, the transcripts
              and the keys stay on hardware you run.
            </Feature>
            <Feature icon={<IconBranches size={28} />} name="Worktrees">
              Every session gets its own branch and checkout so you can run
              agents in parallel.
            </Feature>
            <Feature
              icon={<IconPullRequest size={28} />}
              name="Ends in a pull request"
            >
              Read the diff, then open the PR from the same place the work
              happened. Review stays next to the transcript.
            </Feature>
            <Feature icon={<IconRobot size={28} />} name="Sub-agents">
              Your agents can delegate work to other agents so your main session
              stays focussed.
            </Feature>
            <Feature icon={<IconClock size={28} />} name="Automations">
              Schedules, webhooks and watched channels start sessions on their
              own, each scoped to the tools it is allowed.
            </Feature>
            <Feature
              icon={<IconTerminal size={28} />}
              name="Shells and previews"
            >
              Open a terminal in the worktree, or a preview of the branch
              alongside the session that built it.
            </Feature>
            <Feature icon={<IconStack size={28} />} name="Works where you work">
              Use Open Session on web and desktop, or mobile with the PWA. iOS
              app coming soon.
            </Feature>
            <Feature icon={<IconRepo size={28} />} name="Open source">
              Fork it, adapt it, and make it your own.
            </Feature>
          </div>
        </section>

        <SetupOverview />

        <section className="card">
          <h2>Common questions</h2>
          <div className="faq">
            <Question q="Is it really self-hosted?">
              Yes. You run the server and the agents run against your checkouts
              on your hardware.
            </Question>
            <Question q="Which agents can it run?">
              Any agent you want. A session names a model rather than a vendor,
              and you can change that model between turns.
            </Question>
            <Question q="What does multiplayer actually mean?">
              One session, many people. The transcript updates live for everyone
              watching, you can see who else is there, and anyone can send the
              next turn or answer a question the agent asked.
            </Question>
            <Question q="Do parallel agents share a checkout?">
              No. Each session gets its own git worktree and branch. A session
              can attach a second repository when the work spans more than one.
            </Question>
            <Question q="How does the work get reviewed?">
              As a pull request on the session's branch, with the diff and the
              review beside the transcript that produced them.
            </Question>
            <Question q="Can it run when nobody is watching?">
              Yes. An automation starts a session on a schedule, a webhook or a
              message in a watched channel, with its own allowlist of tools and
              read-only access unless you grant more.
            </Question>
            <Question q="When can I use it?">
              You can use it now. Get started on GitHub and run Open Session on
              your own infrastructure.
            </Question>
          </div>
        </section>

        <footer className="feed-foot">
          <span>©2026</span>
        </footer>
      </main>
      <AnnouncementDialog
        open={announcementOpen}
        onRequestClose={closeAnnouncement}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing landing page root");

createRoot(root).render(
  <>
    <LandingPage />
    <AgentationFeedback />
  </>,
);
