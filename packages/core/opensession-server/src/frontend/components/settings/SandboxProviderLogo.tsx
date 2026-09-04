import type { ReactNode } from "react";
import type { SandboxConnectionInfo } from "../../lib/api";
import { cn } from "../../ui/cn";

type SandboxProvider = SandboxConnectionInfo["provider"];

// Provider-owned marks, bundled locally so Settings never makes a third-party
// request: Daytona's official favicon and Box's mark.
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
        "relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg",
        className,
      )}
    >
      {children}
      <span
        className="pointer-events-none absolute inset-0 rounded-lg"
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
      <SandboxProviderTile className="bg-white text-[#111]">
        <svg
          viewBox="-4.6 0 35.5 35.5"
          className="h-8 w-7"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M20.9863 0C20.9693.0678 16.9743 16.0113 18.71 19.7461c1.7355 3.7334 7.5261 7.3733 7.5537 7.3906-.0157-.0022-6.1516-.8636-9.9678.5459V22.666h-5.0322v5.0322h4.9912c-.1821.0684-.3599.1396-.5303.2188-3.7311 1.7343-7.3688 7.519-7.3906 7.5537.0062-.0439.9536-6.8088-.7803-10.5391C5.8172 21.1961.021 17.5542 0 17.541c.0247.0035 6.8035.9561 10.5391-.7803C14.274 15.0235 20.9628.0528 20.9863 0Z" />
        </svg>
      </SandboxProviderTile>
    );
  }

  return (
    <SandboxProviderTile className="bg-white">
      <img
        className="size-10"
        src={DAYTONA_FAVICON}
        alt=""
        aria-hidden="true"
      />
    </SandboxProviderTile>
  );
}
