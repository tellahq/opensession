/** Whether Slack can POST to the configured webhook URL. Fresh and simple-mode
 * installs resolve to loopback, which Slack's Events API cannot reach. The
 * server only implements HTTP intake, so this decides whether setup can work
 * at all rather than which transport to pick. */
export function publicWebhookAvailable(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return ![
      "127.0.0.1",
      "localhost",
      "::1",
      "[::1]",
      "0.0.0.0",
      "[::]",
    ].includes(host);
  } catch {
    return false;
  }
}
