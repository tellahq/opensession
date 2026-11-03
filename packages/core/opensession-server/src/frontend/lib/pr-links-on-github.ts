// "Open pull requests on GitHub": a PR chip in agent output goes to the PR on
// github.com instead of the review here. On a phone with the GitHub app
// installed, iOS hands that link to the app. Off by default and stored on this
// device only, because whether the app is installed is a fact about the
// device, not the account.

const KEY = "opensession-pr-links-on-github";
const EVENT = "opensession-pr-links-on-github-changed";

export function getPrLinksOnGithubPref(): boolean {
  return localStorage.getItem(KEY) === "on";
}

export function setPrLinksOnGithubPref(on: boolean) {
  if (on) localStorage.setItem(KEY, "on");
  else localStorage.removeItem(KEY);
  window.dispatchEvent(new Event(EVENT));
}

export function onPrLinksOnGithubChanged(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
