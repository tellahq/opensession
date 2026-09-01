import { utilityClassName } from "../ui/cn";
import React, { useState } from "react";
import { cn } from "../ui/cn";
import {
  DEFAULT_APP_ICON_URL,
  useOrganizationIcon,
} from "../hooks/useOrganizationIcon";

/** The organization mark when configured, with the bundled app mark as fallback. */
export function OrganizationAppIcon({ className }: { className?: string }) {
  const configuredSrc = useOrganizationIcon();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const usesOrganizationIcon =
    configuredSrc !== DEFAULT_APP_ICON_URL && failedSrc !== configuredSrc;
  const src = usesOrganizationIcon ? configuredSrc : DEFAULT_APP_ICON_URL;

  return (
    <img
      className={cn(
        usesOrganizationIcon
          ? utilityClassName("block size-11 rounded-control object-cover")
          : utilityClassName("block size-11"),
        className,
      )}
      src={src}
      alt=""
      onError={() => {
        if (src !== DEFAULT_APP_ICON_URL) setFailedSrc(src);
      }}
    />
  );
}
