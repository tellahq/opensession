import React from "react";
import { brandLogo } from "../brand-logos";

export function BrandMark({
  name,
  size = 20,
}: {
  name: string;
  size?: number;
}) {
  const key = name.toLowerCase();
  const logo = brandLogo(key);
  if (!logo) return null;
  return (
    <svg
      data-brand={key}
      viewBox={logo.viewBox}
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      {logo.paths.map((d, i) => (
        <path
          key={i}
          d={d}
          opacity={logo.opacities?.[i]}
          fillRule={logo.evenOdd ? "evenodd" : undefined}
        />
      ))}
    </svg>
  );
}
