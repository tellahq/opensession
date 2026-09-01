import { mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import type { ReactNode } from "react";
import type { SandboxConnectionInfo } from "../../lib/api";
import { cn } from "../../ui/cn";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  inset0: {
    inset: "0",
  },
  roundedLg: {
    borderRadius: "calc(14px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgWhite: {
    backgroundColor: "var(--color-white)",
  },
  text111: {
    color: "#111",
  },
  h8: {
    height: "calc(4px * 8)",
  },
  w7: {
    width: "calc(4px * 7)",
  },
  size10: {
    width: "calc(4px * 10)",
    height: "calc(4px * 10)",
  },
  bgEdf7ff: {
    backgroundColor: "#edf7ff",
  },
  text2496ed: {
    color: "#2496ed",
  },
  size6: {
    width: "calc(4px * 6)",
    height: "calc(4px * 6)",
  },
  bg07140d: {
    backgroundColor: "#07140d",
  },
  text62de61: {
    color: "#62de61",
  },
});

type SandboxProvider = SandboxConnectionInfo["provider"];

// Provider-owned marks, bundled locally so Settings never makes a third-party
// request: Daytona's official favicon; Docker + Modal CC0 paths.
const DAYTONA_FAVICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAMAAABlApw1AAAAHlBMVEUKCgr////k5OSEhIQpKSnIyMhBQUFmZmakpKQZGRlC6tY/AAAACXBIWXMAAAsTAAALEwEAmpwYAAAEZ0lEQVR42u3d627bMAwFYFqMHfX9X3jp0rRObEmkTIokIP0dhp2vaXwRjzBYgi+YgAmYgAmYgAmYgAmYgAmYgECAtKXQgHSDWwoMeOQHSQFY5JcUgEl+QQHY5JcTgFF+MQFY5ZcSgFl+IQHY5ZcRgGF+EQFY5pcQgGl+AQHY5gfYIgAq+UN8Apr5RwBU8w8A6ObXByjnVwfUrj8RnoXU8ysD9PPrAlb9/KqA9Us/vyZgSH5FwJj8HYB0XIb5OwDbMdFql18LMCy/EmBcfh3AwPwqgJH5NQBD8ysAxuaXBwzOLw4YnV8aMDy/MGB8flmAQX5RgEV+SYBJfkFALX++XVvrAED155/h2hoAqOS/p8U/oJb/8XfcAxr53QOwkT8w4Jk/7q/QT/6wX+JX/iXoZfQ3fwTAieAvfwjAQbDLHwPwIdjnDwJ4E7zljwLYCd7zhwH8Cj7yxwH8CD7zWwIS8rdVDvkNAWkD5G5sHfPbAdJ3WuRtLSbaVOe11m1N7dUJSM+w2DGhYUySr73xQzv/h0AU8H8SfkkAhPzvAkmAQJMaaDUBVAFINKmBWHNABYBIkxqoNQ0UB8g0qYFcM0FhgFCTGug1GRQFSDWpgVHzQUGAWJMaODUlFAPINamBVbNCIYBgk/rsE0CoCe7bYa2GTerT70BdcH1tgk3M86uQskCyS1q4D8QRlO7EYQTFZ6EogvLTaBBB5X0ghqD2RhZCUH0njiCo70oEEDT2hfwLWjtz7gXNvVHvgvbmrnMBYXc6uxZQttddC0jzAc8C2oDDsYA4oakI7rYC6ojJrYA8I5MU3I+rW0Af8lUEmfsee1zdnwFjSpnFvsdngF4BZ8yapa5Dp4BOAWtOnIWuo+eAPgFv0J1l7gMFQJeAOanPIvexEqBHwK0aZIn7cBHQIWB3JbLAc0QZwBfwyx75+nNQBVAVCJ1mzZef42qAiiBLHcfNV59Dq4CiIMudJ84Xn6PrgIIgSx6IztfeAxqAU0Hu2Vosr+1W/rOzfyqxAPuaRut5EXg/KMq6nx2PvrMAB0FeTAGfPbQ24F3wlRdTwKEJSADsBV/rYgo4djEpgD9BNf8AwK4NmziAl6CeXx+w7yO/umU0wFPQyK8OeG+E/wiIgG9BK7824LOT/xRQAQ/BupgCjqci/gvIgIu705cBZ+dSvgVRAOcngx6CIIDS2awtxQCUjyduIQC145URANXjoQEA9b1s/4DGXrx7QGuWMAqAfSs3ZyGjAJ2rPcvxDSDMolwDKLM0zwDSLNAxgDbL9AsgzmLdAqizZK8A8izcKYA+y/cJYHQRXAI4XQqPAFYXxCGA12XxB2B2cdwBuF0ibwB2F8oZgN8I9AXoaDS6AqwdjUxfnwDym2jOvgPIbqJ5uwoht4nm7j6AzCaavzsx8ppo63FZPwuhwpnXsU+jaJRf7n0AbfILvpGhSX7Jd2K0yC+6K4EG+WX3hXB8fuGdOcT5/xNPwARMwARMwARMwARMwARMwARQAf8Agnd/k0M+tPcAAAAASUVORK5CYII=";

const tileStyle = {
  boxShadow:
    "inset 0 0 0 1px light-dark(oklch(0 0 0 / 0.1), oklch(1 0 0 / 0.1))",
};

function SandboxProviderTile({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        utilityClassName(
          "relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg",
        ),
        className,
      )}
    >
      {children}
      <span
        {...stylex.props(
          sx.pointerEventsNone,
          sx.absolute,
          sx.inset0,
          sx.roundedLg,
        )}
        style={tileStyle}
        aria-hidden="true"
      />
    </span>
  );
}

export function SandboxProviderLogo({
  provider,
}: {
  provider: SandboxProvider;
}) {
  if (provider === "box") {
    return (
      <SandboxProviderTile
        className={mergeStylexOverrideClassName("", sx.bgWhite, sx.text111)}
      >
        <svg
          viewBox="-4.6 0 35.5 35.5"
          {...stylex.props(sx.h8, sx.w7)}
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M20.9863 0C20.9693.0678 16.9743 16.0113 18.71 19.7461c1.7355 3.7334 7.5261 7.3733 7.5537 7.3906-.0157-.0022-6.1516-.8636-9.9678.5459V22.666h-5.0322v5.0322h4.9912c-.1821.0684-.3599.1396-.5303.2188-3.7311 1.7343-7.3688 7.519-7.3906 7.5537.0062-.0439.9536-6.8088-.7803-10.5391C5.8172 21.1961.021 17.5542 0 17.541c.0247.0035 6.8035.9561 10.5391-.7803C14.274 15.0235 20.9628.0528 20.9863 0Z" />
        </svg>
      </SandboxProviderTile>
    );
  }

  if (provider === "daytona") {
    return (
      <SandboxProviderTile
        className={mergeStylexOverrideClassName("", sx.bgWhite)}
      >
        <img
          {...stylex.props(sx.size10)}
          src={DAYTONA_FAVICON}
          alt=""
          aria-hidden="true"
        />
      </SandboxProviderTile>
    );
  }

  if (provider === "docker") {
    return (
      <SandboxProviderTile
        className={mergeStylexOverrideClassName("", sx.bgEdf7ff, sx.text2496ed)}
      >
        <svg
          viewBox="0 0 24 24"
          {...stylex.props(sx.size6)}
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M13.983 11.078h2.119a.186.186 0 0 0 .186-.185V9.006a.186.186 0 0 0-.186-.186h-2.119a.185.185 0 0 0-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 0 0 .186-.186V3.574a.186.186 0 0 0-.186-.185h-2.118a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 0 0 .186-.186V6.29a.186.186 0 0 0-.186-.185h-2.118a.185.185 0 0 0-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 0 0 .184-.186V6.29a.185.185 0 0 0-.185-.185H8.1a.185.185 0 0 0-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 0 0 .185-.186V6.29a.185.185 0 0 0-.185-.185H5.136a.186.186 0 0 0-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 0 0 .186-.185V9.006a.186.186 0 0 0-.186-.186h-2.118a.185.185 0 0 0-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 0 0 .184-.185V9.006a.185.185 0 0 0-.184-.186h-2.12a.185.185 0 0 0-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 0 0 .185-.185V9.006a.185.185 0 0 0-.184-.186h-2.12a.186.186 0 0 0-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 0 0 .184-.185V9.006a.185.185 0 0 0-.184-.186h-2.12a.185.185 0 0 0-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 0 0-.75.748 11.376 11.376 0 0 0 .692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 0 0 3.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z" />
        </svg>
      </SandboxProviderTile>
    );
  }

  return (
    <SandboxProviderTile
      className={mergeStylexOverrideClassName("", sx.bg07140d, sx.text62de61)}
    >
      <svg
        viewBox="0 0 24 24"
        {...stylex.props(sx.size6)}
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M4.89 5.57 0 14.002l2.521 4.4h5.05l4.396-7.718 4.512 7.709 4.996.037L24 14.057l-4.857-8.452-5.073-.015-2.076 3.598L9.94 5.57Zm.837.729h3.787l1.845 3.252H7.572Zm9.189.021 3.803.012 4.228 7.355-3.736-.027zm-9.82.346L6.94 9.914l-4.209 7.389-1.892-3.3Zm9.187.014 4.297 7.343-1.892 3.282-4.3-7.344zm-6.713 3.6h3.79l-4.212 7.394H3.361Zm11.64 4.109 3.74.027-1.893 3.281-3.74-.027z" />
      </svg>
    </SandboxProviderTile>
  );
}
