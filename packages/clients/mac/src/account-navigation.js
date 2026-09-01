function accountForContext(accounts, activeId, assignedId, currentUrl) {
  const assigned = accounts.find((account) => account.id === assignedId);
  if (assigned) return assigned;
  try {
    const origin = new URL(currentUrl || "").origin;
    const navigated = accounts.find(
      (account) => new URL(account.url).origin === origin,
    );
    if (navigated) return navigated;
  } catch {}
  return accounts.find((account) => account.id === activeId) || null;
}

const APP_ROUTE_ROOTS = new Set([
  "analytics",
  "archived",
  "automations",
  "catchup",
  "connections",
  "feed",
  "goals",
  "new",
  "people",
  "plain",
  "pr",
  "reports",
  "reviews",
  "security",
  "session",
  "settings",
  "support",
  "support-tinder",
  "tasks",
  "welcome",
  "workspace",
]);

/**
 * Whether a URL is an Open Session app route for this account.
 *
 * Origin alone is not enough: reports, assets, downloads and other API
 * responses are served by the same host, but they are documents for the
 * person's browser rather than pages the desktop shell should own.
 */
function isOpenSessionAppUrl(accountUrl, candidate) {
  if (!candidate) return false;
  try {
    const account = new URL(accountUrl);
    const target = new URL(candidate);
    if (!/^https?:$/.test(target.protocol) || target.origin !== account.origin)
      return false;
    const root = target.pathname.split("/").find(Boolean);
    return root === undefined || APP_ROUTE_ROOTS.has(root);
  } catch {
    return false;
  }
}

function resumableAccountUrl(accountUrl, candidate) {
  if (!isOpenSessionAppUrl(accountUrl, candidate)) return null;
  return new URL(candidate).toString();
}

module.exports = {
  accountForContext,
  isOpenSessionAppUrl,
  resumableAccountUrl,
};
