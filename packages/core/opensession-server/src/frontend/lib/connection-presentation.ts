// Keep transient transport drops from repainting connection-specific UI. This
// matches the reconnect notice: brief foreground blips and all background time
// stay quiet, while a sustained visible outage is still explained.
export const CONNECTION_PRESENTATION_GRACE_MS = 8_000;
