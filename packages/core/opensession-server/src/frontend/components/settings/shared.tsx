import type * as React from "react";
import {
  SettingRow as SettingsRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
} from "../../ui/settings";

// ── Reusable controls ──────────────────────────────────────────────────────
//
// Deliberately thin, and deliberately still here: SettingRow is a convenience
// prop-API over ui/settings' composable row parts, so there is no styling of
// its own to drift. Panels use toggles via ui/switch's Switch directly; there
// is no wrapper for it.
//
// `Select` is ui/select's own options-array component, re-exported under the
// name the panels here already import.

export { OptionSelect as Select } from "../../ui/select";

export function SettingRow({
  title,
  desc,
  control,
}: {
  title: React.ReactNode;
  desc?: React.ReactNode;
  control: React.ReactNode;
}) {
  return (
    <SettingsRow>
      <SettingRowText>
        <SettingRowTitle>{title}</SettingRowTitle>
        {desc != null && <SettingRowDescription>{desc}</SettingRowDescription>}
      </SettingRowText>
      <SettingRowControl>{control}</SettingRowControl>
    </SettingsRow>
  );
}
