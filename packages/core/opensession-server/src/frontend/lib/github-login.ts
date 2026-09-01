const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

/** A GitHub login entered directly, with @, or as a pasted profile URL. */
export function githubLoginFromInput(input: string): string | null {
  let value = input.trim();
  if (!value) return null;

  const looksLikeProfileUrl = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(
    value,
  );
  if (looksLikeProfileUrl) {
    try {
      const url = new URL(
        /^https?:\/\//i.test(value) ? value : `https://${value}`,
      );
      if (url.hostname.toLowerCase().replace(/^www\./, "") !== "github.com")
        return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 1) return null;
      value = decodeURIComponent(parts[0]);
    } catch {
      return null;
    }
  } else {
    if (value.includes("://")) return null;
    value = value.replace(/^@+/, "");
  }

  return GITHUB_LOGIN.test(value) ? value : null;
}
