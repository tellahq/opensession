import React from "react";

type SettingsProps = React.ComponentProps<typeof import("./Settings").Settings>;

const SettingsComponent = React.lazy(async () => {
  const { Settings } = await import("./Settings");
  return { default: Settings };
});

export function DeferredSettings(props: SettingsProps) {
  return (
    <React.Suspense fallback={null}>
      <SettingsComponent {...props} />
    </React.Suspense>
  );
}
