import { useEffect, useState, type ReactNode } from "react";
import { BASE_PATH } from "../lib/base";
import { effectiveTheme, onThemeChanged } from "../lib/theme";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import { IconChevronLeft } from "./icons";

const MAC_DOWNLOAD_URL =
  "https://github.com/tellahq/opensession/releases/latest/download/OpenSession-arm64.dmg";

/** Apple's mark, for the Mac download. A solid glyph, not part of the stroke set. */
function IconApple({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M16.365 1.43c0 1.14-.417 2.2-1.25 3.06-.99 1.02-2.09 1.61-3.28 1.52a3.3 3.3 0 0 1-.02-.4c0-1.09.47-2.25 1.3-3.09.42-.43.95-.79 1.6-1.08.64-.28 1.25-.44 1.82-.47.02.15.03.3.03.46zM20.6 17.02c-.32.74-.7 1.42-1.14 2.05-.6.86-1.09 1.45-1.47 1.78-.59.54-1.22.82-1.9.84-.48 0-1.07-.14-1.75-.42-.68-.28-1.31-.42-1.89-.42-.6 0-1.25.14-1.94.42-.7.28-1.26.43-1.69.44-.65.03-1.29-.26-1.92-.86-.41-.36-.92-.97-1.53-1.83-.65-.92-1.19-1.98-1.6-3.2-.45-1.31-.68-2.58-.68-3.81 0-1.4.3-2.61.91-3.62a5.35 5.35 0 0 1 1.9-1.93 5.1 5.1 0 0 1 2.57-.72c.51 0 1.18.16 2.02.47.83.31 1.37.47 1.6.47.18 0 .78-.19 1.79-.55.96-.34 1.77-.48 2.43-.42 1.79.14 3.14.85 4.03 2.13-1.6.97-2.39 2.33-2.38 4.07.02 1.36.51 2.49 1.48 3.38.44.42.93.74 1.47.97-.12.34-.24.66-.38.97z" />
    </svg>
  );
}

export function DownloadAppsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [showInstallHelp, setShowInstallHelp] = useState(false);

  useEffect(() => {
    if (!open) setShowInstallHelp(false);
  }, [open]);

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content widthClassName="max-w-[48rem]">
        <Modal.Header
          title={
            showInstallHelp ? (
              <span className="flex min-w-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<IconChevronLeft size={18} />}
                  className="-ml-1 size-7 shrink-0"
                  onClick={() => setShowInstallHelp(false)}
                  aria-label="Back to apps"
                />
                <span className="truncate">Install the web app</span>
              </span>
            ) : (
              "Download apps"
            )
          }
        />
        <DownloadAppsBody
          showInstallHelp={showInstallHelp}
          onShowInstallHelp={() => setShowInstallHelp(true)}
        />
      </Modal.Content>
    </Modal.Root>
  );
}

/**
 * The two app cards, or the three PWA steps once the web card is picked. Split
 * out of the dialog so Settings › Downloads can host the same thing inline —
 * one description of what you can install, two places to reach it.
 */
export function DownloadAppsBody({
  showInstallHelp,
  onShowInstallHelp,
}: {
  showInstallHelp: boolean;
  onShowInstallHelp: () => void;
}) {
  const [theme, setTheme] = useState(effectiveTheme);
  useEffect(() => onThemeChanged(() => setTheme(effectiveTheme())), []);
  const backgroundName =
    theme === "dark" ? "download-background-dark" : "download-background";

  if (showInstallHelp)
    return (
      <div className="grid min-h-0 flex-1 gap-3 desktop:grid-cols-3">
        <InstallStep number="1" title="Open in your browser">
          Use Safari on iPhone or iPad, or Chrome on Android and desktop.
        </InstallStep>
        <InstallStep number="2" title="Open the browser menu">
          On iPhone or iPad, tap Share. Elsewhere, open the browser menu.
        </InstallStep>
        <InstallStep number="3" title="Add Open Session">
          Choose Add to Home Screen, Install app, or Add to Dock.
        </InstallStep>
      </div>
    );

  return (
    <div className="grid min-h-0 flex-1 gap-4 desktop:grid-cols-[3fr_2fr]">
      <AppCard
        preview={
          <div
            className="relative h-full overflow-hidden bg-cover bg-center pl-5 pt-5"
            style={{
              backgroundImage: `url(${BASE_PATH}/${backgroundName}.webp)`,
            }}
          >
            <img
              src={`${BASE_PATH}/download-mac.webp`}
              alt="Open Session running on Mac"
              className="h-full w-full rounded-tl-lg object-cover object-left-top outline outline-1 -outline-offset-1 outline-black/10"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-b from-transparent to-surface" />
          </div>
        }
        title="Open Session for Mac"
        subtitle="Apple silicon"
      >
        <Button
          variant="primary"
          size="lg"
          icon={<IconApple size={20} />}
          className="min-h-10 w-full"
          render={<a href={MAC_DOWNLOAD_URL} />}
        >
          Download
        </Button>
      </AppCard>

      <AppCard
        preview={
          <div
            className="relative flex h-full justify-center overflow-hidden bg-cover bg-center px-3 pt-6"
            style={{
              backgroundImage: `url(${BASE_PATH}/${backgroundName}.webp)`,
            }}
          >
            <img
              src={`${BASE_PATH}/download-phone.webp`}
              alt="Open Session installed as a phone web app"
              className="relative z-10 h-[130%] w-auto max-w-none origin-top rounded-2xl object-contain object-top smooth-shadow-lg"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-1/3 bg-gradient-to-b from-transparent to-surface" />
          </div>
        }
        title="Web"
        subtitle="Install as a PWA"
      >
        <Button
          variant="soft"
          size="lg"
          className="min-h-10 w-full"
          onClick={onShowInstallHelp}
        >
          How to install
        </Button>
      </AppCard>
    </div>
  );
}

function AppCard({
  preview,
  title,
  subtitle,
  children,
}: {
  preview: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="flex h-[20rem] flex-col overflow-hidden rounded-[calc(22px*var(--rf))] bg-surface desktop:h-[22rem]">
      <div className="min-h-0 flex-1">{preview}</div>
      <div className="relative z-10 flex shrink-0 flex-col px-4 pb-4 desktop:px-5 desktop:pb-5">
        <h3 className="m-0 text-section-title font-semibold leading-tight text-fg">
          {title}
        </h3>
        <p className="mb-4 mt-1 text-body font-medium text-dim">{subtitle}</p>
        {children}
      </div>
    </section>
  );
}

function InstallStep({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex min-h-48 flex-col rounded-xl bg-panel p-5 desktop:min-h-60">
      <div className="mb-auto flex size-10 items-center justify-center rounded-control bg-accent text-body font-semibold text-on-accent">
        {number}
      </div>
      <h3 className="mb-1 mt-6 text-section-title font-semibold leading-tight text-fg">
        {title}
      </h3>
      <p className="m-0 text-body font-normal leading-relaxed text-dim">
        {children}
      </p>
    </section>
  );
}
