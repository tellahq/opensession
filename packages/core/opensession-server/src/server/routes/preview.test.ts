import { describe, expect, test } from "bun:test";
import { recipeCommand, unavailableSandboxPreviewStatus } from "./preview";

describe("declared Portal commands", () => {
  test("wraps environment exports inside the supervised shell", () => {
    const command = recipeCommand({
      id: "app",
      name: "App",
      command: "./.agents/start.sh",
      serviceKey: "WEBAPP_PORT",
    });
    expect(command).toStartWith("bash -c ");
    expect(command).toContain('export WEBAPP_PORT="$PORT"');
    expect(command).toContain("exec ./.agents/start.sh");
    expect(command).not.toStartWith("exec export");
  });
});

describe("preview routing while a sandbox is unavailable", () => {
  test("keeps a preparing sandbox off the host preview path", () => {
    expect(
      unavailableSandboxPreviewStatus({
        sandbox: { provider: "daytona", lifecycle: "preparing" },
      }),
    ).toMatchObject({
      running: false,
      starting: true,
      bootable: false,
      sandboxLifecycle: "preparing",
    });
  });

  test("does not represent a missing awake sandbox as host-bootable", () => {
    expect(
      unavailableSandboxPreviewStatus({
        sandbox: {
          provider: "box",
          sandboxId: "bx_missing",
          lifecycle: "awake",
        },
      }),
    ).toMatchObject({ running: false, starting: false, bootable: false });
  });

  test("leaves non-sandbox sessions on the host preview path", () => {
    expect(unavailableSandboxPreviewStatus({})).toBeNull();
  });
});
