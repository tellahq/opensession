const { validateIntent, executeIntent } = require("./mac-keychain");

function reviewOptions(record, origin) {
  const intent = validateIntent(record.intent);
  const body =
    intent.body === undefined
      ? "None"
      : JSON.stringify(intent.body).replace(
          /[\u007f-\uffff]/g,
          (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
        );
  return {
    detail: [
      `Open Session: ${origin}`,
      `Session: ${record.sessionId}`,
      `Requested by: ${record.login}`,
      "",
      `Purpose: ${intent.purpose}`,
      `Keychain service: ${JSON.stringify(intent.service)}`,
      `Keychain account: ${JSON.stringify(intent.account)}`,
      "",
      `${intent.method} ${intent.url}`,
      `Secret header: ${intent.injection === "bearer" ? "Authorization: Bearer" : "x-api-key"}`,
      `JSON body (quoted): ${body}`,
      "",
      "Only HTTP status returns to the agent. No redirects.",
      "macOS may ask to access this Keychain item.",
      "Choose Allow for one-time access, not Always Allow.",
    ].join("\n"),
  };
}

// Only a native menu click calls review(). There is no renderer IPC for reading
// secrets or invoking this approval UI. Dependencies make the whole chain
// testable without a real account, network request, or Keychain access.
class MacKeychainReview {
  constructor({
    dialog,
    context,
    approve = require("./mac-keychain-menu").showKeychainRequestMenu,
    execute = executeIntent,
  }) {
    this.dialog = dialog;
    this.context = context;
    this.execute = execute;
    this.approve = approve;
    this.busy = false;
  }

  async review(target) {
    if (this.busy) return;
    this.busy = true;
    try {
      const current = this.context(target);
      if (!current) {
        await this.dialog.showMessageBox(target, {
          message: "Open a session first",
          detail:
            "View the requesting session in the Mac app, then choose Keychain requests again.",
        });
        return;
      }
      const { origin, sessionId, pageUrl } = current;
      const stillHere = () => {
        const next = this.context(target);
        return next?.pageUrl === pageUrl && next?.origin === origin;
      };
      const api = async (route, body) => {
        const response = await target.webContents.session.fetch(
          `${origin}/api/mac-keychain/${route}`,
          {
            method: body === undefined ? "GET" : "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!response.ok) throw new Error("Request unavailable");
        return response.json();
      };
      const { request } = await api(
        `pending?sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (!stillHere()) return;
      if (!request) {
        await this.dialog.showMessageBox(target, {
          message: "No pending macOS Keychain request",
          detail:
            "Requests expire after 10 minutes and are visible only to the signed-in teammate who prompted the agent.",
        });
        return;
      }
      if (
        request.sessionId !== sessionId ||
        !/^[a-f0-9-]{36}$/.test(request.id) ||
        typeof request.login !== "string" ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(request.login) ||
        !Number.isFinite(request.expiresAt) ||
        request.expiresAt <= Date.now()
      )
        throw new Error("Invalid request");
      const intent = validateIntent(request.intent);
      const { response } = await this.approve(
        target,
        reviewOptions({ ...request, intent }, origin),
      );
      if (!stillHere() || request.expiresAt <= Date.now()) return;
      const { claim } = await api(`${request.id}/claim`, {});
      if (typeof claim !== "string" || !/^[a-f0-9-]{36}$/.test(claim))
        throw new Error("Invalid claim");
      // Navigation, sign-out, or expiry while claiming must not unlock macOS Keychain.
      const outcome =
        response === 1 && stillHere() && request.expiresAt > Date.now()
          ? await this.execute(intent)
          : { status: "declined" };
      // executeIntent returns only a closed result shape. Never attach an error,
      // helper output, response text, or any part of the secret to this POST.
      await api(`${request.id}/complete`, { claim, outcome });
      if (stillHere())
        await this.dialog.showMessageBox(target, {
          message:
            outcome.status === "completed"
              ? `Request finished (HTTP ${outcome.httpStatus})`
              : outcome.status === "declined"
                ? "Request declined"
                : "Request failed",
          detail:
            outcome.status === "failed"
              ? "Keychain access may have been denied, the service/account may not match an existing generic-password item, or the destination may be unavailable. The request is spent; no automatic retry was made."
              : "No secret or response content was sent to the agent.",
        });
    } catch {
      if (target && !target.isDestroyed())
        await this.dialog.showMessageBox(target, {
          message: "macOS Keychain request unavailable",
          detail:
            "Check your Open Session sign-in and connection. The request may have expired or been reviewed on another Mac. If execution already started, it will not be retried automatically.",
        });
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { MacKeychainReview, reviewOptions };
