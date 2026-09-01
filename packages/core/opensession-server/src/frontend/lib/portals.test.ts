import { describe, expect, test } from "bun:test";
import { portalTargetFor } from "./portals";

describe("portalTargetFor", () => {
  test("opens only running services with an authenticated URL", () => {
    expect(
      portalTargetFor("session-1", {
        name: "Webapp",
        key: "WEBAPP_PORT",
        port: 3300,
        running: true,
        pids: [],
        previewUrl: "https://os.example.test:23000",
      }),
    ).toEqual({
      sessionId: "session-1",
      name: "Webapp",
      key: "WEBAPP_PORT",
      port: 3300,
      url: "https://os.example.test:23000",
    });
  });

  test("keeps stopped and unpublished services out of the browser", () => {
    const service = {
      name: "Temporal UI",
      key: "TEMPORAL_UI_PORT",
      port: 8312,
      pids: [],
    };
    expect(
      portalTargetFor("session-1", { ...service, running: false }),
    ).toBeNull();
    expect(
      portalTargetFor("session-1", {
        ...service,
        running: true,
        previewUrl: null,
      }),
    ).toBeNull();
  });
});
