import { useEffect, useSyncExternalStore } from "react";
import {
  fetchOrganizationSettings,
  type OrganizationSettingsDto,
} from "../lib/api";

export const DEFAULT_APP_ICON_URL = "/mac-app-icon.png?v=7";

let iconUrl: string | null | undefined;
let organizationName: string | undefined;
let request: Promise<void> | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function setIconUrl(next: string | null) {
  if (iconUrl === next) return;
  iconUrl = next;
  emit();
}

function setOrganizationName(next: string) {
  if (organizationName === next) return;
  organizationName = next;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Keep the organization identity in step with a successful General settings update. */
export function rememberOrganizationIcon(settings: OrganizationSettingsDto) {
  generation += 1;
  setIconUrl(settings.organizationIconUrl);
  setOrganizationName(settings.organizationName);
}

async function refreshOrganizationIcon() {
  if (request) return request;
  const startedAt = generation;
  request = fetchOrganizationSettings()
    .then((settings) => {
      // A settings save that finished while this request was in flight owns the
      // newer value. Do not let the older response put its identity back.
      if (generation === startedAt) {
        setIconUrl(settings.organizationIconUrl);
        setOrganizationName(settings.organizationName);
      }
    })
    .catch(() => {
      // The bundled mark is the offline and older-server fallback.
      if (generation === startedAt) setIconUrl(null);
    })
    .finally(() => {
      request = null;
    });
  return request;
}

/** The revisioned organization icon URL, or the bundled Open Session mark. */
export function useOrganizationIcon(): string {
  const configuredUrl = useSyncExternalStore(
    subscribe,
    () => iconUrl,
    () => undefined,
  );
  useEffect(() => {
    if (iconUrl === undefined) void refreshOrganizationIcon();
  }, []);
  return configuredUrl || DEFAULT_APP_ICON_URL;
}

/** The configured organization name, sharing the icon request above. */
export function useOrganizationName(): string {
  const configuredName = useSyncExternalStore(
    subscribe,
    () => organizationName,
    () => undefined,
  );
  useEffect(() => {
    if (organizationName === undefined) void refreshOrganizationIcon();
  }, []);
  return configuredName || "Open Session";
}
