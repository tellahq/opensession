import { useEffect, useState } from "react";

import { PHONE_QUERY } from "../lib/breakpoints";

/** Reactive "is this a phone-width viewport?" — components use it to swap in
 * phone-specific surfaces (bottom sheets) instead of desktop popups/pages. */
export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => setIsPhone(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isPhone;
}
