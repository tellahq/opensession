import { useEffect, useState } from "react";
import { useIsPhone } from "../hooks/useIsPhone";
import {
  RADIUS_SPECIMENS,
  SHADOW_SPECIMENS,
  SURFACE_SPECIMENS,
  TYPE_SPECIMENS,
} from "../lib/design-system-route";
import {
  effectiveTheme,
  onThemeChanged,
  setThemePref,
  type EffectiveTheme,
} from "../lib/theme";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardList } from "../ui/card";
import { Checkbox } from "../ui/checkbox";
import { cn } from "../ui/cn";
import { Field, Input, Textarea } from "../ui/input";
import { Menu } from "../ui/menu";
import { PageLayout } from "../ui/page";
import { Popover } from "../ui/popover";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { OptionSelect } from "../ui/select";
import {
  SettingCard,
  SettingGroup,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  SettingsGroupLabel,
} from "../ui/settings";
import { ResponsiveDialog } from "../ui/sheet";
import {
  EmptyState,
  InlineAlert,
  ListSkeleton,
  LoadingState,
} from "../ui/state";
import { PulseDot, WorkingPill } from "../ui/status";
import { Switch } from "../ui/switch";
import { PlateTabs, UnderlineTabs } from "../ui/tabs";
import {
  IconBolt,
  IconCheck,
  IconChecklist,
  IconFilter,
  IconPlus,
  IconRepo,
  IconSliders,
} from "./icons";

function SectionLabel({ children }: { children: string }) {
  return (
    <h2 className="m-0 mb-3 mt-10 text-section-title font-title text-fg">
      {children}
    </h2>
  );
}

export function DesignSystemGallery() {
  const isPhone = useIsPhone();
  const [theme, setTheme] = useState<EffectiveTheme>(() => effectiveTheme());
  const [range, setRange] = useState("14d");
  const [density, setDensity] = useState("default");
  const [underlineTab, setUnderlineTab] = useState("overview");
  const [plateTab, setPlateTab] = useState("threads");
  const [switchOn, setSwitchOn] = useState(true);
  const [checked, setChecked] = useState(true);
  const [mode, setMode] = useState("balanced");
  const [nameInput, setNameInput] = useState("Open Session");
  const [notesInput, setNotesInput] = useState(
    "Quiet, borderless surfaces separated by elevation, spacing, and squircle radii.",
  );
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    document.getElementById("splash")?.remove();
    return onThemeChanged(() => setTheme(effectiveTheme()));
  }, []);

  const handleThemeChange = (next: string) => {
    if (next === "dark" || next === "light") {
      setThemePref(next);
      setTheme(next);
    }
  };

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-surface text-fg">
      <PageLayout
        title="Design system"
        description="Live reference for Open Session surfaces, type scale, radii, shadows, and Base UI primitives. Available in dev and demo builds."
        contentWidth="wide"
        actions={
          <Segmented
            label="Theme"
            value={theme}
            onValueChange={handleThemeChange}
          >
            <SegmentedOption value="dark">Dark</SegmentedOption>
            <SegmentedOption value="light">Light</SegmentedOption>
          </Segmented>
        }
      >
        <section aria-label="Surfaces and elevation">
          <SectionLabel>Surfaces and elevation</SectionLabel>
          <div className="grid grid-cols-2 gap-3 desktop:grid-cols-5">
            {SURFACE_SPECIMENS.map((item) => (
              <div key={item.token} className="flex flex-col gap-1.5">
                <div
                  className={cn(
                    "flex h-20 items-end rounded-xl p-3",
                    item.swatchClass,
                  )}
                >
                  <span className="truncate font-mono text-meta text-dim">
                    {item.token}
                  </span>
                </div>
                <span className="px-1 text-meta text-faint">{item.role}</span>
              </div>
            ))}
          </div>
        </section>

        <section aria-label="Type scale">
          <SectionLabel>Type scale</SectionLabel>
          <CardList>
            {TYPE_SPECIMENS.map((item) => (
              <div
                key={item.token}
                className="flex flex-col gap-1 px-5 py-3.5 desktop:flex-row desktop:items-baseline desktop:justify-between desktop:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <div className={item.sampleClass}>{item.sample}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2 font-mono text-meta text-faint">
                  <span>{item.token}</span>
                  <span>·</span>
                  <span>{item.sizes}</span>
                </div>
              </div>
            ))}
          </CardList>
        </section>

        <section aria-label="Buttons and badges">
          <SectionLabel>Buttons and badges</SectionLabel>
          <Card className="flex flex-col gap-5 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" icon={<IconPlus size={20} />}>
                Create session
              </Button>
              <Button variant="default">Default</Button>
              <Button variant="soft">Soft</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="success" icon={<IconCheck size={20} />}>
                Approve
              </Button>
              <Button variant="warning">Caution</Button>
              <Button variant="danger">Delete</Button>
              <Button variant="default" caret>
                Filter
              </Button>
              <Button
                variant="default"
                icon={<IconSliders size={20} />}
                aria-label="Adjust filters"
              />
              <Button variant="default" disabled>
                Disabled
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg">Large</Button>
              <WorkingPill />
              <span className="inline-flex items-center gap-1.5 text-label text-dim">
                <PulseDot />
                Live
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-divider pt-4">
              <Badge tone="neutral">Neutral</Badge>
              <Badge tone="accent" dot>
                Accent
              </Badge>
              <Badge tone="success" dot>
                Merged
              </Badge>
              <Badge tone="warning" dot>
                Pending
              </Badge>
              <Badge tone="danger" dot>
                Failed
              </Badge>
              <Badge tone="info" dot>
                Running
              </Badge>
              <Badge tone="neutral" variant="outline">
                main
              </Badge>
              <Badge tone="accent" variant="outline">
                Preview
              </Badge>
            </div>
          </Card>
        </section>

        <section aria-label="Navigation and switching">
          <SectionLabel>Navigation and switching</SectionLabel>
          <Card className="flex flex-col gap-5 p-5">
            <div className="flex flex-wrap items-center gap-4">
              <Segmented
                label="Time range"
                value={range}
                onValueChange={setRange}
              >
                <SegmentedOption value="7d">7d</SegmentedOption>
                <SegmentedOption value="14d">14d</SegmentedOption>
                <SegmentedOption value="30d">30d</SegmentedOption>
              </Segmented>
              <Segmented
                label="Density"
                size="sm"
                value={density}
                onValueChange={setDensity}
              >
                <SegmentedOption value="default">Default</SegmentedOption>
                <SegmentedOption value="compact">Compact</SegmentedOption>
              </Segmented>
            </div>

            <div className="border-b border-divider">
              <UnderlineTabs.Root
                label="Pull request views"
                value={underlineTab}
                onValueChange={setUnderlineTab}
              >
                <UnderlineTabs.Tab
                  value="overview"
                  icon={<IconChecklist size={16} />}
                >
                  Overview
                </UnderlineTabs.Tab>
                <UnderlineTabs.Tab
                  value="files"
                  icon={<IconRepo size={16} />}
                  count={8}
                >
                  Files changed
                </UnderlineTabs.Tab>
              </UnderlineTabs.Root>
            </div>

            <div>
              <PlateTabs.Root
                label="Side panel tabs"
                value={plateTab}
                onValueChange={setPlateTab}
              >
                <PlateTabs.Tab
                  value="threads"
                  icon={<IconBolt size={16} />}
                  attention
                >
                  Threads
                </PlateTabs.Tab>
                <PlateTabs.Tab value="filters" icon={<IconFilter size={16} />}>
                  Filters
                </PlateTabs.Tab>
              </PlateTabs.Root>
            </div>
          </Card>
        </section>

        <section aria-label="Settings plate and form controls">
          <SettingsGroupLabel>
            Settings plate and form controls
          </SettingsGroupLabel>
          <SettingCard>
            <SettingGroup>
              <SettingRow>
                <SettingRowText>
                  <SettingRowTitle>Automatic previews</SettingRowTitle>
                  <SettingRowDescription>
                    Start an isolated preview whenever a branch pushes changes.
                  </SettingRowDescription>
                </SettingRowText>
                <SettingRowControl>
                  <Switch
                    checked={switchOn}
                    onCheckedChange={setSwitchOn}
                    aria-label="Automatic previews"
                  />
                </SettingRowControl>
              </SettingRow>
            </SettingGroup>

            <SettingRow>
              <SettingRowText>
                <SettingRowTitle>Review cadence</SettingRowTitle>
                <SettingRowDescription>
                  Select uses the same popup surface as menus across the app.
                </SettingRowDescription>
              </SettingRowText>
              <SettingRowControl>
                <OptionSelect
                  label="Review cadence"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "quiet", label: "Quiet" },
                    { value: "balanced", label: "Balanced" },
                    { value: "strict", label: "Strict" },
                  ]}
                />
              </SettingRowControl>
            </SettingRow>

            <div className="flex flex-col gap-4 px-5 py-4">
              <Field label="Display name" htmlFor="ds-name">
                <Input
                  id="ds-name"
                  value={nameInput}
                  onChange={(event) => setNameInput(event.target.value)}
                />
              </Field>
              <Field label="Design notes" htmlFor="ds-notes">
                <Textarea
                  id="ds-notes"
                  rows={2}
                  value={notesInput}
                  onChange={(event) => setNotesInput(event.target.value)}
                />
              </Field>
              <label className="inline-flex cursor-pointer items-center gap-2.5 text-label text-fg">
                <Checkbox
                  checked={checked}
                  onCheckedChange={setChecked}
                  aria-label="Verify both themes before shipping"
                />
                <span>Verify desktop and phone in both themes</span>
              </label>
            </div>
          </SettingCard>
        </section>

        <section aria-label="Smooth shadows and overlays">
          <SectionLabel>Smooth shadows and overlays</SectionLabel>
          <div className="grid grid-cols-1 gap-4 desktop:grid-cols-4">
            {SHADOW_SPECIMENS.map((item) => (
              <div
                key={item.token}
                className={cn(
                  "flex min-h-24 flex-col justify-between p-4",
                  item.className,
                )}
              >
                <span className="font-mono text-meta text-fg">
                  {item.token}
                </span>
                <span className="text-meta text-dim">{item.role}</span>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Menu.Root>
              <Menu.Trigger
                render={
                  <Button variant="default" caret>
                    Open menu
                  </Button>
                }
              />
              <Menu.Popup align="start">
                <Menu.Item>Duplicate workspace</Menu.Item>
                <Menu.Item>Copy session link</Menu.Item>
                <Menu.Separator />
                <Menu.Item className="text-red">Archive session</Menu.Item>
              </Menu.Popup>
            </Menu.Root>

            <Popover.Root>
              <Popover.Trigger
                render={<Button variant="default">Open popover</Button>}
              />
              <Popover.Popup align="start" className="w-64 p-3.5">
                <div className="text-item-title font-medium text-fg">
                  Floating surface
                </div>
                <p className="m-0 mt-1 text-supporting text-dim">
                  Popovers use popup glass and smooth-shadow-ring-md with no
                  extra border.
                </p>
              </Popover.Popup>
            </Popover.Root>

            <Button variant="default" onClick={() => setDialogOpen(true)}>
              Open responsive dialog
            </Button>
          </div>

          <ResponsiveDialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            phone={isPhone}
            label="Sample responsive dialog"
            modalClassName="w-[440px] max-w-[calc(100vw-32px)] p-5"
            sheetClassName="p-5"
          >
            {(dismiss) => (
              <div className="flex flex-col gap-3">
                <h3 className="m-0 text-dialog-title font-title text-fg">
                  Responsive dialog
                </h3>
                <p className="m-0 text-supporting text-dim">
                  Renders as a centered modal on desktop and a bottom sheet with
                  safe-area clearance on phone.
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <Button variant="ghost" onClick={dismiss}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={dismiss}>
                    Done
                  </Button>
                </div>
              </div>
            )}
          </ResponsiveDialog>
        </section>

        <section aria-label="States and feedback">
          <SectionLabel>States and feedback</SectionLabel>
          <div className="flex flex-col gap-3">
            <InlineAlert variant="info" title="Info">
              New semantic tokens live in styles/tailwind.css.
            </InlineAlert>
            <InlineAlert variant="warn" title="Warning">
              Never pair smooth-shadow-ring-* with an extra border utility.
            </InlineAlert>
            <InlineAlert variant="error" title="Error">
              Unknown color tokens fail bun scripts/ui-audit.ts.
            </InlineAlert>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 desktop:grid-cols-2">
            <EmptyState
              placement="card"
              title="No open reviews"
              action={<Button size="sm">Refresh</Button>}
            >
              Empty states reuse shared spacing and surface tokens.
            </EmptyState>
            <Card className="overflow-hidden">
              <LoadingState placement="row">Checking preview…</LoadingState>
              <div className="border-t border-line">
                <ListSkeleton variant="rows" rows={2} />
              </div>
            </Card>
          </div>
        </section>

        <section aria-label="Squircle radius scale">
          <SectionLabel>Squircle radius scale</SectionLabel>
          <div className="grid grid-cols-3 gap-3 desktop:grid-cols-9">
            {RADIUS_SPECIMENS.map((item) => (
              <div
                key={item.token}
                className="flex flex-col items-center gap-1.5"
              >
                <div
                  className={cn(
                    "grid h-14 w-full place-items-center bg-panel text-meta text-dim",
                    item.radiusClass,
                  )}
                >
                  {item.px}
                </div>
                <span className="truncate font-mono text-meta text-faint">
                  {item.token}
                </span>
              </div>
            ))}
          </div>
        </section>
      </PageLayout>
    </main>
  );
}
