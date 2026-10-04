import { useEffect, useSyncExternalStore } from "react";
import {
  supportsCapability,
  type CapabilityKey,
} from "@tellahq/opensession-protocol/capabilities";
import {
  acquireServerCapabilities,
  serverDescriptorSnapshot,
  subscribeServerDescriptor,
} from "../lib/server-capabilities";

export function useServerCapability(
  key: CapabilityKey,
  minimumVersion = 1,
): boolean {
  const descriptor = useSyncExternalStore(
    subscribeServerDescriptor,
    serverDescriptorSnapshot,
    () => null,
  );
  useEffect(acquireServerCapabilities, []);
  return supportsCapability(descriptor, key, minimumVersion);
}
