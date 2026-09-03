import React, { useEffect, useState } from "react";
import {
  fetchInstanceIdentity,
  saveInstanceIdentity,
  type InstanceIdentityDto,
} from "../lib/api";
import { AGENT_NAME, PRODUCT_NAME } from "../lib/brand";
import { errorMessage } from "../lib/error-message";
import { cn } from "../ui/cn";
import { Field } from "../ui/input";
import {
  SettingRow,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
  settingsInputClass,
} from "../ui/settings";
import { toast } from "../ui/toast";

// What this instance and its agent are called. These rows sit inside the
// organization card, so Setup and Workspace > General both show one section.

const IDENTITY_INPUT_CLASS = cn(settingsInputClass, "w-[140px] max-w-full");

/** One identity field: saves on blur or Enter, reverts on Escape or failure. */
function IdentityInput({
  label,
  value,
  placeholder,
  onSave,
  className,
}: {
  label: string;
  value: string;
  placeholder: string;
  onSave: (next: string) => Promise<void>;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const commit = async () => {
    const next = draft.trim();
    if (saving) return;
    if (next === value) {
      setDraft(value);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
    } catch {
      // The owning save handler shows the error; this boundary only restores
      // the last persisted value.
      setDraft(value);
    }
    setSaving(false);
  };
  return (
    <input
      className={cn(IDENTITY_INPUT_CLASS, className)}
      // data-setup-field: FirstMile's onboarding wrapper widens these fields
      // past their settings-page width; settings ignores the attribute.
      data-setup-field="identity"
      value={draft}
      disabled={saving}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") setDraft(value);
      }}
      placeholder={placeholder}
      aria-label={label}
    />
  );
}

/** The instance's own names, as rows. They live inside the organization card
 *  so setup and settings show one section rather than two near-identical ones. */
export function IdentityRows({
  showProductName = true,
  rowClassName,
  compact = false,
}: {
  showProductName?: boolean;
  rowClassName?: string;
  compact?: boolean;
} = {}) {
  const [identity, setIdentity] = useState<InstanceIdentityDto | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const dto = await fetchInstanceIdentity();
        if (!cancelled) setIdentity(dto);
      } catch (error) {
        if (!cancelled) {
          toast(errorMessage(error, "Failed to load identity"), {
            variant: "error",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const save = async (patch: {
    personaName?: string;
    productName?: string;
  }) => {
    try {
      setIdentity(await saveInstanceIdentity(patch));
      toast("Saved. Open tabs update after the next rebuild.", {
        variant: "success",
      });
    } catch (error) {
      toast(errorMessage(error, "Failed to save"), { variant: "error" });
      throw error;
    }
  };

  if (compact) {
    return (
      <Field label={<span className="text-fg">Agent name</span>}>
        <IdentityInput
          label="Agent name"
          value={identity?.personaName ?? AGENT_NAME}
          placeholder="Assistant"
          onSave={(next) => save({ personaName: next })}
          className="h-12! min-h-12! w-full! px-3.5! text-base!"
        />
        <span
          data-onboarding-caption=""
          className="text-supporting font-normal text-dim"
        >
          Shown in prompts, Slack messages, and the app.
        </span>
      </Field>
    );
  }

  return (
    <>
      <SettingRow className={rowClassName}>
        <SettingRowText>
          <SettingRowTitle>Agent name</SettingRowTitle>
          <SettingRowDescription>
            Shown in prompts, Slack messages, and the app.
          </SettingRowDescription>
        </SettingRowText>
        <IdentityInput
          label="Agent name"
          value={identity?.personaName ?? AGENT_NAME}
          placeholder="Assistant"
          onSave={(next) => save({ personaName: next })}
        />
      </SettingRow>
      {showProductName && (
        <SettingRow className={rowClassName}>
          <SettingRowText>
            <SettingRowTitle>Product name</SettingRowTitle>
            <SettingRowDescription>
              Shown in titles and headings.
            </SettingRowDescription>
          </SettingRowText>
          <IdentityInput
            label="Product name"
            value={identity?.productName ?? PRODUCT_NAME}
            placeholder="Open Session"
            onSave={(next) => save({ productName: next })}
          />
        </SettingRow>
      )}
    </>
  );
}
