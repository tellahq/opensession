import React from "react";
import { importOrReload } from "../lib/chunk-reload";

type SettingsProps = React.ComponentProps<typeof import("./Settings").Settings>;

const SettingsComponent = React.lazy(async () => {
  const { Settings } = await importOrReload(() => import("./Settings"));
  return { default: Settings };
});

export function DeferredSettings(props: SettingsProps) {
  return (
    <React.Suspense fallback={null}>
      <SettingsComponent {...props} />
    </React.Suspense>
  );
}
