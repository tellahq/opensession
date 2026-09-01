import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import markAsset from "../mac/build/icon-512.png";
import nativeMarkAsset from "../ios/OS1/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png";
import {
  IconCheck,
  IconCheckCircle,
  IconChevronLeft,
  IconCopy,
  IconGlobe,
  IconPhone,
  IconServer,
  IconSparkle,
  IconTerminal,
} from "../../core/opensession-server/src/frontend/components/icons";
import "./site.css";
import "./setup.css";
import { AgentationFeedback } from "./AgentationFeedback";
import { assetUrl } from "./asset-url";

const markUrl = assetUrl(markAsset);
const nativeMarkUrl = assetUrl(nativeMarkAsset);

type ProviderId = "hetzner" | "digitalocean" | "aws" | "macmini" | "existing";
type SetupOptionId =
  | "new"
  | "existing"
  | "local"
  | "remote"
  | "ubuntu"
  | "debian";

interface Provider {
  id: ProviderId;
  name: string;
  detail: string;
  url?: string;
  login: string;
}

// Official monochrome marks from Simple Icons (CC0).
const providerLogos: Partial<
  Record<ProviderId, { viewBox: string; path: string }>
> = {
  hetzner: {
    viewBox: "0 0 24 24",
    path: "M0 0v24h24V0H0zm4.602 4.025h2.244c.509 0 .716.215.716.717v5.64h8.883v-5.64c0-.509.215-.717.717-.717h2.229c.5 0 .71.23.724.717v14.516c0 .509-.215.717-.717.717h-2.23c-.51 0-.717-.215-.717-.717v-5.735H7.562v5.735c0 .516-.215.717-.716.717H4.602c-.51 0-.717-.208-.717-.717V4.742c0-.509.207-.717.717-.717z",
  },
  digitalocean: {
    viewBox: "0 0 24 24",
    path: "M12.04 0C5.408-.02.005 5.37.005 11.992h4.638c0-4.923 4.882-8.731 10.064-6.855a6.95 6.95 0 014.147 4.148c1.889 5.177-1.924 10.055-6.84 10.064v-4.61H7.391v4.623h4.61V24c7.86 0 13.967-7.588 11.397-15.83-1.115-3.59-3.985-6.446-7.575-7.575A12.8 12.8 0 0012.039 0zM7.39 19.362H3.828v3.564H7.39zm-3.563 0v-2.978H.85v2.978z",
  },
  aws: {
    viewBox: "0 0 24 24",
    path: "M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 0 0-.735-.136 6.02 6.02 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 5.55a1.398 1.398 0 0 1-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 0 1 .32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 0 1 .311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 0 1-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 0 1-.303.08h-.687c-.151 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32l-1.238-5.148-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 0 1-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.319.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 0 0 .415-.758.777.777 0 0 0-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 0 1-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .359.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 0 1 .24.2.43.43 0 0 1 .071.263v.375c0 .168-.064.256-.184.256a.83.83 0 0 1-.303-.096 3.652 3.652 0 0 0-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.159.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926-.144.272-.336.511-.583.703-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167zM21.698 16.207c-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351 3.384 1.963 7.559 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.439-.2.814.287.383.607zM22.792 14.961c-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151.32-.79 1.03-2.57.695-2.994z",
  },
  macmini: {
    viewBox: "0 0 24 24",
    path: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
  },
};

const providers: Provider[] = [
  {
    id: "hetzner",
    name: "Hetzner",
    detail: "Good value",
    url: "https://console.hetzner.cloud/",
    login: "root",
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    detail: "Simple setup",
    url: "https://cloud.digitalocean.com/droplets/new",
    login: "root",
  },
  {
    id: "aws",
    name: "AWS",
    detail: "More control",
    url: "https://console.aws.amazon.com/ec2/home#LaunchInstances:",
    login: "ubuntu",
  },
  {
    id: "macmini",
    name: "Mac mini",
    detail: "Run it at home",
    login: "YOUR_MAC_USERNAME",
  },
  {
    id: "existing",
    name: "My own server",
    detail: "Ubuntu or Debian",
    login: "root",
  },
];

function setupOptionsFor(provider: Provider): Array<{
  id: SetupOptionId;
  name: string;
  detail: string;
}> {
  if (provider.id === "macmini") {
    return [
      { id: "local", name: "Set up this Mac", detail: "Enable Remote Login" },
      { id: "remote", name: "Set up another Mac", detail: "Connect over SSH" },
    ];
  }
  if (provider.id === "existing") {
    return [
      { id: "ubuntu", name: "Ubuntu 24.04", detail: "Recommended" },
      { id: "debian", name: "Debian 12", detail: "Also supported" },
    ];
  }
  return [
    {
      id: "new",
      name: "Create a new server",
      detail: `Guided ${provider.name} setup`,
    },
    {
      id: "existing",
      name: "Use an existing server",
      detail: "I already have its SSH details",
    },
  ];
}

const macDownloadUrl =
  "https://github.com/tellahq/opensession/releases/latest/download/OpenSession-arm64.dmg";
const tailscaleCommand =
  "curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --ssh";
const createUserCommand =
  "adduser --disabled-password --gecos '' opensession && usermod -aG sudo opensession && printf 'opensession ALL=(ALL) NOPASSWD:ALL\\n' >/etc/sudoers.d/opensession && chmod 440 /etc/sudoers.d/opensession && if [ -s ~/.ssh/authorized_keys ]; then install -d -m 700 -o opensession -g opensession /home/opensession/.ssh && cp ~/.ssh/authorized_keys /home/opensession/.ssh/ && chown opensession:opensession /home/opensession/.ssh/authorized_keys; else passwd opensession; fi";

function Mark() {
  return <img className="setup-mark" src={markUrl} alt="" />;
}

function ProviderLogo({ provider }: { provider: Provider }) {
  const logo = providerLogos[provider.id];
  return (
    <span
      className={`setup-provider-mark setup-provider-${provider.id}`}
      aria-hidden="true"
    >
      {logo ? (
        <svg viewBox={logo.viewBox} role="presentation">
          <path d={logo.path} />
        </svg>
      ) : (
        <IconTerminal size={23} />
      )}
    </span>
  );
}

function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  return (
    <div className="setup-command">
      <code>{command}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopyState("copied");
          } catch {
            setCopyState("failed");
          }
        }}
        aria-label={
          copyState === "copied" ? `${label} copied` : `Copy ${label}`
        }
      >
        {copyState === "copied" ? (
          <IconCheck size={17} />
        ) : (
          <IconCopy size={17} />
        )}
        <span>
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Select manually"
              : "Copy"}
        </span>
      </button>
    </div>
  );
}

function Choice({
  selected,
  provider,
  onSelect,
}: {
  selected: boolean;
  provider: Provider;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="setup-choice"
      data-selected={selected || undefined}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <ProviderLogo provider={provider} />
      <span className="setup-choice-copy">
        <strong>{provider.name}</strong>
        <small>{provider.detail}</small>
      </span>
      <span className="setup-radio" aria-hidden="true" />
    </button>
  );
}

const stepLabels = ["Server", "Setup", "Tailscale", "Download", "Open"];

function StepNav({
  step,
  onSelect,
  canSelect,
}: {
  step: number;
  onSelect: (step: number) => void;
  canSelect: (step: number) => boolean;
}) {
  return (
    <nav className="setup-step-nav" aria-label="Setup steps">
      {stepLabels.map((label, index) => (
        <button
          key={label}
          type="button"
          data-state={
            index < step ? "done" : index === step ? "current" : undefined
          }
          aria-current={index === step ? "step" : undefined}
          disabled={!canSelect(index)}
          onClick={() => onSelect(index)}
        >
          <span className="setup-step-dot" aria-hidden="true" />
          <span className="setup-step-label">{label}</span>
        </button>
      ))}
    </nav>
  );
}

function StepLayout({
  title,
  description,
  brand,
  contentClassName,
  children,
}: {
  title: string;
  description: string;
  brand?: ReactNode;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className="setup-step-layout">
      <div className="setup-copy setup-step-copy">
        <h1 tabIndex={-1}>{title}</h1>
        <p>{description}</p>
        {brand}
      </div>
      <div
        className={`setup-step-content${contentClassName ? ` ${contentClassName}` : ""}`}
      >
        {children}
      </div>
    </div>
  );
}

function SetupPage() {
  const [step, setStep] = useState(0);
  const [providerId, setProviderId] = useState<ProviderId | null>(null);
  const provider =
    providers.find((item) => item.id === providerId) ?? providers[0]!;
  const [setupOption, setSetupOption] = useState<SetupOptionId | null>(null);
  const [login, setLogin] = useState(provider.login);
  const [serverAddress, setServerAddress] = useState("");
  const [serverConnected, setServerConnected] = useState(false);
  const [tailnetAddress, setTailnetAddress] = useState("");

  function chooseProvider(next: Provider) {
    setProviderId(next.id);
    setSetupOption(null);
    setLogin(next.login);
    setServerConnected(false);
  }

  const hasServerDetails = Boolean(serverAddress.trim() && login.trim());
  const serverSetupItems =
    provider.id === "macmini"
      ? [
          "Use a dedicated Apple silicon Mac",
          "Turn on Remote Login in System Settings",
          "Keep it powered on and connected",
        ]
      : provider.id === "existing"
        ? [
            setupOption === "debian" ? "Use Debian 12" : "Use Ubuntu 24.04",
            "Provide at least 2 vCPU, 8 GB RAM, and 50 GB disk",
            "Make sure your account has sudo access",
          ]
        : [
            setupOption === "existing"
              ? `Open your existing ${provider.name} server`
              : `Create a ${provider.name} server`,
            "Choose Ubuntu 24.04",
            "Use at least 2 vCPU, 8 GB RAM, and 50 GB disk",
            "Add your SSH key",
          ];
  const sshCommand = `ssh ${login || "ubuntu"}@${serverAddress || "YOUR_SERVER_IP"}`;
  const instanceUrl = (() => {
    const address = tailnetAddress.trim();
    if (!address) return "";
    try {
      const url = new URL(
        /^https?:\/\//.test(address) ? address : `http://${address}`,
      );
      if (!url.port) url.port = "3850";
      return url.href;
    } catch {
      return "";
    }
  })();

  useEffect(() => {
    document
      .querySelector<HTMLElement>(".setup-panel h1")
      ?.focus({ preventScroll: true });
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [step]);

  const panels = [
    <section className="setup-panel" key="server">
      <StepLayout
        title="Choose a server"
        description="Choose where Open Session will run and how you want to set it up."
        contentClassName="setup-step-content-split"
      >
        <div className="setup-server-picker">
          <section className="setup-server-list-panel">
            <div className="setup-choices">
              {providers.map((item) => (
                <Choice
                  key={item.id}
                  provider={item}
                  selected={item.id === providerId}
                  onSelect={() => chooseProvider(item)}
                />
              ))}
            </div>
          </section>

          <section
            className="setup-server-options-panel"
            data-empty={!providerId || undefined}
            aria-live="polite"
          >
            {providerId ? (
              <div className="setup-server-options-content" key={providerId}>
                <div className="setup-server-options-heading">
                  <ProviderLogo provider={provider} />
                  <div>
                    <strong>Set up {provider.name}</strong>
                    <span>Choose one option to continue.</span>
                  </div>
                </div>
                <div className="setup-server-options">
                  {setupOptionsFor(provider).map((option) => (
                    <button
                      type="button"
                      key={option.id}
                      className="setup-server-option"
                      data-selected={setupOption === option.id || undefined}
                      aria-pressed={setupOption === option.id}
                      onClick={() => {
                        setSetupOption(option.id);
                        setServerConnected(false);
                      }}
                    >
                      <span>
                        <strong>{option.name}</strong>
                        <small>{option.detail}</small>
                      </span>
                      <span className="setup-radio" aria-hidden="true" />
                    </button>
                  ))}
                </div>
                <div className="setup-server-requirements">
                  <strong>
                    {provider.id === "macmini"
                      ? "Dedicated Mac recommended"
                      : setupOption === "debian"
                        ? "Debian 12"
                        : "Ubuntu 24.04"}
                  </strong>
                  <span>
                    {provider.id === "macmini"
                      ? "Apple silicon · 16 GB memory · macOS 14 or later"
                      : "2 vCPU · 8 GB RAM · 50 GB disk"}
                  </span>
                </div>
              </div>
            ) : (
              <div className="setup-server-options-empty">
                <div
                  className="setup-server-options-empty-icon"
                  aria-hidden="true"
                >
                  <IconSparkle size={24} />
                </div>
                <strong>Choose a server</strong>
                <span>Select one to see setup options.</span>
              </div>
            )}
          </section>
        </div>
      </StepLayout>
    </section>,
    <section className="setup-panel" key="connect">
      <StepLayout
        title={`Set up ${provider.name}`}
        description="Create the server, connect over SSH, and confirm it is ready."
        contentClassName="setup-step-content-split"
      >
        <div className="setup-server-setup">
          <section className="setup-server-guide">
            <div className="setup-server-provider">
              <ProviderLogo provider={provider} />
              <div>
                <strong>{provider.name}</strong>
                <span>{provider.detail}</span>
              </div>
              {provider.url && setupOption === "new" && (
                <a href={provider.url} target="_blank" rel="noreferrer">
                  Create server <span aria-hidden="true">↗</span>
                </a>
              )}
            </div>

            <ol className="setup-server-checklist">
              {serverSetupItems.map((item, index) => (
                <li key={item}>
                  <span>{index + 1}</span>
                  {item}
                </li>
              ))}
            </ol>

            <div className="setup-instruction-heading setup-server-credentials-heading">
              <span>Connection</span>
              <strong>Connect over SSH</strong>
              <p>Enter the details from your provider, then run the command.</p>
            </div>
            <div className="setup-fields">
              <label>
                <span>IP address or hostname</span>
                <input
                  value={serverAddress}
                  onChange={(event) => {
                    setServerAddress(event.target.value);
                    setServerConnected(false);
                  }}
                  placeholder="203.0.113.10"
                  inputMode="url"
                  autoComplete="off"
                />
              </label>
              <label className="setup-user-field">
                <span>Username</span>
                <input
                  value={login}
                  onChange={(event) => {
                    setLogin(event.target.value);
                    setServerConnected(false);
                  }}
                  autoComplete="username"
                />
              </label>
            </div>
            <CopyCommand command={sshCommand} label="SSH command" />

            {login === "root" ? (
              <div className="setup-substep">
                <div className="setup-substep-heading">
                  <span>Open Session user</span>
                  <strong>Create a separate admin user</strong>
                  <p>Run this after the SSH connection opens.</p>
                </div>
                <CopyCommand
                  command={createUserCommand}
                  label="create user command"
                />
                <div className="setup-reconnect">
                  <strong>Reconnect as the new user</strong>
                  <code>
                    ssh opensession@{serverAddress || "YOUR_SERVER_IP"}
                  </code>
                </div>
              </div>
            ) : (
              <p className="setup-note">
                <IconTerminal size={17} /> Keep the SSH session open for the
                next step.
              </p>
            )}
          </section>

          <aside
            className="setup-server-status"
            data-connected={serverConnected || undefined}
            aria-live="polite"
          >
            <div className="setup-connection-visual" aria-hidden="true">
              <span className="setup-connection-node">
                <IconTerminal size={23} />
              </span>
              <span className="setup-connection-track">
                <span />
              </span>
              <span className="setup-connection-node">
                <IconServer size={23} />
              </span>
            </div>
            <div className="setup-server-status-copy">
              <strong>
                {serverConnected
                  ? "Server connected"
                  : "Waiting for your server"}
              </strong>
              <p>
                {serverConnected
                  ? `${login}@${serverAddress} is ready.`
                  : hasServerDetails
                    ? "Run the SSH command, then confirm when Terminal connects."
                    : "Add the server address and username to continue."}
              </p>
            </div>
            <button
              type="button"
              className="setup-confirm-connection"
              data-connected={serverConnected || undefined}
              disabled={!hasServerDetails || serverConnected}
              aria-pressed={serverConnected}
              onClick={() => setServerConnected(true)}
            >
              <span className="setup-confirm-icon" aria-hidden="true">
                <IconServer className="setup-confirm-icon-pending" size={18} />
                <IconCheckCircle
                  className="setup-confirm-icon-connected"
                  size={18}
                />
              </span>
              {serverConnected ? "Connected" : "I've connected over SSH"}
            </button>
          </aside>
        </div>
      </StepLayout>
    </section>,
    <section className="setup-panel" key="tailscale">
      <StepLayout
        title="Secure access"
        description="Tailscale creates a private network between your server and devices, keeping Open Session off the public internet. Sign in once, then add every device that needs access."
        brand={
          <span className="setup-product-brand" aria-label="Tailscale">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M24 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm-9 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm0-9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm6-6a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 24a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm18 .5a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm9-9a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm-3 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 3a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM3 5.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
            </svg>
            <span>Tailscale</span>
          </span>
        }
      >
        <div className="setup-instruction-block">
          <div className="setup-instruction-heading">
            <span>1 · Server</span>
            <strong>Connect the server</strong>
            <p>
              Run this in your SSH session, then open the sign-in link it
              prints.
            </p>
          </div>
          <CopyCommand command={tailscaleCommand} label="Tailscale command" />
        </div>
        <div className="setup-instruction-block">
          <div className="setup-instruction-heading">
            <span>2 · Your devices</span>
            <strong>Join the same network</strong>
            <p>
              Install Tailscale on your Mac and phone, then sign in with the
              same account.
            </p>
          </div>
          <a
            className="setup-device-link"
            href="https://tailscale.com/download"
            target="_blank"
            rel="noreferrer"
          >
            <IconGlobe size={17} />
            Download Tailscale <span aria-hidden="true">↗</span>
          </a>
        </div>
      </StepLayout>
    </section>,
    <section className="setup-panel" key="install">
      <StepLayout
        title="Download apps"
        description="Get the Mac app, open it in a browser, or install it on your phone."
      >
        <div className="setup-download-options">
          <a className="setup-download-card" href={macDownloadUrl}>
            <img src={markUrl} alt="" />
            <span className="setup-download-card-copy">
              <strong>Mac app</strong>
              <small>Electron · Apple silicon</small>
            </span>
            <span className="setup-download-action">Download</span>
          </a>
          <button
            type="button"
            className="setup-download-card"
            onClick={() => setStep(4)}
          >
            <span className="setup-download-mark" aria-hidden="true">
              <IconGlobe size={26} />
            </span>
            <span className="setup-download-card-copy">
              <strong>Web</strong>
              <small>Any browser on your tailnet · Nothing to install</small>
            </span>
            <span className="setup-download-action">Open</span>
          </button>
          <details className="setup-terminal-option">
            <summary>
              <span
                className="setup-download-mark setup-download-mark-dark"
                aria-hidden="true"
              >
                <IconPhone size={26} />
              </span>
              <span className="setup-download-card-copy">
                <strong>iPhone and iPad PWA</strong>
                <small>Add the web app to your home screen</small>
              </span>
              <IconChevronLeft className="setup-terminal-chevron" size={17} />
            </summary>
            <div className="setup-terminal-content">
              <ol className="setup-mini-steps">
                <li>
                  <span className="setup-mini-step-index">1</span>
                  <span>Install Tailscale on the phone and sign in.</span>
                </li>
                <li>
                  <span className="setup-mini-step-index">2</span>
                  <span>
                    Open your instance in Safari, for example{" "}
                    <code>http://100.64.12.34:3850</code>.
                  </span>
                </li>
                <li>
                  <span className="setup-mini-step-index">3</span>
                  <span>Tap Share, then Add to Home Screen.</span>
                </li>
                <li>
                  <span className="setup-mini-step-index">4</span>
                  <span>Open it from the home screen for full screen.</span>
                </li>
              </ol>
            </div>
          </details>
          <div className="setup-download-card" aria-disabled="true">
            <img src={nativeMarkUrl} alt="" />
            <span className="setup-download-card-copy">
              <strong>iOS app</strong>
              <small>Native app · App Store</small>
            </span>
            <span className="setup-download-action">Coming soon</span>
          </div>
        </div>
      </StepLayout>
    </section>,
    <section className="setup-panel" key="open">
      <StepLayout
        title="Finish in Open Session"
        description="Open your private instance to connect GitHub, AI, and your repositories."
      >
        <div className="setup-ready-card">
          <Mark />
          <div>
            <strong>Your private instance is ready</strong>
            <span>Enter its Tailscale address to continue.</span>
          </div>
        </div>
        <label className="setup-address-field">
          <span>Tailscale address</span>
          <input
            value={tailnetAddress}
            onChange={(event) => setTailnetAddress(event.target.value)}
            placeholder="100.64.12.34"
            inputMode="url"
            autoComplete="url"
          />
        </label>
        {instanceUrl ? (
          <a
            className="setup-open-button"
            href={instanceUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open Open Session <span aria-hidden="true">↗</span>
          </a>
        ) : (
          <button type="button" className="setup-open-button" disabled>
            Enter your Tailscale address
          </button>
        )}
        <details className="setup-final-help">
          <summary>Having trouble opening it?</summary>
          <div className="setup-final-help-content">
            <p>Run this diagnostic command on the server.</p>
            <CopyCommand
              command="~/.opensession/bin/opensession doctor"
              label="doctor command"
            />
            <p>
              If it reports no service, run{" "}
              <code>~/.opensession/bin/opensession service install</code>.
            </p>
          </div>
        </details>
      </StepLayout>
    </section>,
  ];

  return (
    <div className="setup-page" data-setup-wizard>
      <header className="setup-header">
        <button
          type="button"
          className="setup-header-back"
          onClick={() => setStep((current) => Math.max(0, current - 1))}
          disabled={step === 0}
          aria-label="Back"
        >
          <IconChevronLeft size={18} />
        </button>
        <StepNav
          step={step}
          onSelect={setStep}
          canSelect={(nextStep) =>
            nextStep === 0 ||
            Boolean(setupOption && (nextStep === 1 || serverConnected))
          }
        />
        <a className="setup-home-link" href="./">
          <span className="setup-home-wide">Back to website</span>
          <span className="setup-home-compact">Exit</span>
        </a>
      </header>

      <main className="setup-panel-wrap">{panels[step]}</main>

      <footer className="setup-actions">
        <button
          type="button"
          className="setup-back"
          onClick={() => setStep((current) => Math.max(0, current - 1))}
          disabled={step === 0}
        >
          <IconChevronLeft size={17} />
          Back
        </button>
        {step < 4 ? (
          <button
            type="button"
            className="setup-continue"
            onClick={() => setStep(step + 1)}
            disabled={
              (step === 0 && !setupOption) || (step === 1 && !serverConnected)
            }
          >
            {step === 0 && !setupOption
              ? "Choose setup option"
              : step === 1 && !serverConnected
                ? "Confirm connection"
                : "Next"}
          </button>
        ) : (
          <a className="setup-quiet-button" href="./">
            Back to website
          </a>
        )}
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <>
    <SetupPage />
    <AgentationFeedback />
  </>,
);
