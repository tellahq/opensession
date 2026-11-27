import { expect, test } from "bun:test";
import type { PreviewStatus } from "./api";
import {
  lastPreviewStatus,
  rememberPreviewStatus,
} from "./preview-status-memory";

const status = (port: number): PreviewStatus => ({
  services: [{ name: "web", key: "web", port, running: true, pids: [] }],
});

test("a session reopens on the status it last reported", () => {
  expect(lastPreviewStatus("s-a")).toBeNull();
  rememberPreviewStatus("s-a", status(3000));
  rememberPreviewStatus("s-b", status(4000));
  expect(lastPreviewStatus("s-a")?.services[0]?.port).toBe(3000);
  expect(lastPreviewStatus("s-b")?.services[0]?.port).toBe(4000);
});

test("a cleared status is forgotten", () => {
  rememberPreviewStatus("s-c", status(5000));
  rememberPreviewStatus("s-c", null);
  expect(lastPreviewStatus("s-c")).toBeNull();
});

test("only the most recent sessions are kept", () => {
  for (let i = 0; i < 205; i++) rememberPreviewStatus(`bulk-${i}`, status(i));
  expect(lastPreviewStatus("bulk-0")).toBeNull();
  expect(lastPreviewStatus("bulk-204")?.services[0]?.port).toBe(204);
});
