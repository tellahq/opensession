import { useEffect, useState } from "react";
import {
  fetchSandboxStatus,
  saveSandboxDefault,
  type SandboxStatusInfo,
} from "../../lib/api";
import { errorMessage } from "../../lib/error-message";
import {
  SettingCard,
  SettingsGroupLabel,
  SettingsHint,
} from "../../ui/settings";
import { toast } from "../../ui/toast";
import { getCurrentUser } from "../UserPicker";
import { Select, SettingRow } from "./shared";

type Scope = "workspace" | "personal";

function providerLabel(id: string): string {
  if (id === "none") return "None";
  if (id === "docker") return "Docker";
  if (id === "daytona") return "Daytona";
  if (id === "e2b") return "E2B";
  if (id === "box") return "Box";
  if (id === "modal") return "Modal";
  if (id === "lambda-microvm") return "AWS Lambda MicroVM";
  return id;
}

function SandboxDefaultRow({
  scope,
  canManage = true,
}: {
  scope: Scope;
  canManage?: boolean;
}) {
  const user = getCurrentUser();
  const [status, setStatus] = useState<SandboxStatusInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    fetchSandboxStatus(user)
      .then(setStatus)
      .catch((error) =>
        setLoadError(
          errorMessage(error, "Failed to load available sandbox providers"),
        ),
      );
  }, [user]);

  if (!status?.defaults) {
    return (
      <SettingRow
        title="Default sandbox"
        desc={loadError || "Loading available sandbox providers…"}
        control={
          <span className="text-supporting text-faint">
            {loadError ? "Unavailable" : "Loading…"}
          </span>
        }
      />
    );
  }

  const providers = status.connections?.length
    ? status.connections
        .filter((connection) => connection.state === "ready")
        .map((connection) => ({ id: connection.provider }))
    : status.providers.filter(
        (provider) => provider.configured && provider.certified,
      );
  const workspace = status.defaults.workspace || "none";
  const value =
    scope === "workspace" ? workspace : status.defaults.personal || "workspace";
  const available = new Set<string>(providers.map((provider) => provider.id));
  const unavailableSelection =
    value !== "workspace" && value !== "none" && !available.has(value)
      ? [
          {
            value,
            label: `${providerLabel(value)} · unavailable`,
            disabled: true,
          },
        ]
      : [];
  const options = [
    ...(scope === "personal"
      ? [
          {
            value: "workspace",
            label: `Workspace default · ${providerLabel(workspace)}`,
          },
        ]
      : []),
    { value: "none", label: "None" },
    ...unavailableSelection,
    ...providers.map((provider) => ({
      value: provider.id,
      label: providerLabel(provider.id),
    })),
  ];

  async function save(next: string) {
    setSaving(true);
    await (async () => {
      const response = await saveSandboxDefault({ scope, value: next, user });
      setStatus((current) =>
        current ? { ...current, defaults: response.defaults } : current,
      );
    })()
      .catch(async (error) => {
        toast(errorMessage(error, "Failed to save sandbox default"), {
          variant: "error",
        });
        fetchSandboxStatus(user)
          .then(setStatus)
          .catch(() => {
            // The save error is already visible and the pre-save status remains valid.
          });
      })
      .finally(async () => {
        setSaving(false);
      });
  }

  return (
    <SettingRow
      title="Default sandbox"
      desc={
        scope === "personal"
          ? "Your environment for new sessions."
          : "The environment for new sessions."
      }
      control={
        <div className={saving ? "pointer-events-none opacity-60" : undefined}>
          <Select
            label={`${scope === "personal" ? "Personal" : "Workspace"} default sandbox`}
            value={value}
            options={options}
            onChange={(next) => void save(next)}
            disabled={scope === "workspace" && !canManage}
          />
        </div>
      }
    />
  );
}

export function PersonalSandboxDefaultRow() {
  return <SandboxDefaultRow scope="personal" />;
}

export function WorkspaceSandboxDefaults({
  canManage = true,
}: {
  canManage?: boolean;
}) {
  return (
    <>
      <SettingsGroupLabel className="mt-0">
        Session environment
      </SettingsGroupLabel>
      <SettingCard>
        <SandboxDefaultRow scope="workspace" canManage={canManage} />
      </SettingCard>
      <SettingsHint>
        None uses this host. Only tested providers appear here.
      </SettingsHint>
    </>
  );
}
