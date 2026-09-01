import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  renderIngressUnit,
  renderLauncher,
  renderSessionKernelLauncher,
  renderSessionKernelPlist,
  renderSessionKernelUnit,
  renderSocketUnit,
  renderUnit,
} from "../scripts/lib/service";

const repoRoot = resolve(import.meta.dir, "..");

describe("session kernel service deployment", () => {
  test("orders the authenticated actor before the gateway without coupling their stop lifecycle", async () => {
    const gateway = await renderUnit("system");
    const ingress = await renderIngressUnit("system");
    const socket = await renderSocketUnit("system");
    const actor = await Bun.file(
      resolve(repoRoot, "opensession-session-kernel.service"),
    ).text();
    expect(gateway).toContain(
      "Wants=opensession.socket opensession-ingress.service",
    );
    expect(gateway).not.toContain("Sockets=opensession.socket");
    expect(ingress).toContain("Requires=opensession.socket");
    expect(ingress).toContain("Sockets=opensession.socket");
    expect(socket).toContain("ListenStream=127.0.0.1:3850");
    expect(socket).toContain("Service=opensession-ingress.service");
    expect(gateway).not.toContain("Wants=opensession-session-kernel.service");
    expect(gateway).not.toContain(
      "Requires=opensession-session-kernel.service",
    );
    expect(gateway).toContain("LoadCredential=session-kernel-token:");
    expect(actor).toContain("IPAddressAllow=localhost");
    expect(actor).toContain("IPAddressDeny=any");
    expect(actor).not.toContain("EnvironmentFile=");
  });

  test("leaves no gateway-side actor or writable-store fallback", async () => {
    const runtime = await Bun.file(
      resolve(
        repoRoot,
        "packages/core/opensession-server/src/server/session-kernel/actor-runtime.ts",
      ),
    ).text();
    expect(runtime).toContain("session-kernel-transport-worker.js");
    expect(runtime).not.toContain('workerEntry("session-kernel-worker.js"');
    expect(runtime).not.toContain("new SessionKernelStore");
    const kernel = await Bun.file(
      resolve(
        repoRoot,
        "packages/core/opensession-server/src/server/session-kernel/kernel.ts",
      ),
    ).text();
    expect(kernel).toContain('process.env.NODE_ENV === "test"');
    expect(kernel).toContain(
      "Session kernel store requires the authoritative actor service",
    );
  });

  test("renders source and rootless units with minimal state environment", async () => {
    const system = await renderSessionKernelUnit("system");
    const user = await renderSessionKernelUnit("user");
    expect(system).toContain(
      "packages/core/opensession-server/src/session-kernel-service.ts",
    );
    expect(system).toContain(
      "LoadCredential=session-kernel-token:/etc/opensession/session-kernel-token",
    );
    expect(system).toContain("Slice=opensession-control.slice");
    expect(system).not.toContain("EnvironmentFile=");
    expect(user).not.toMatch(/^User=/m);
    expect(user).not.toContain("Slice=opensession-control.slice");
    expect(user).not.toContain("IPAddressDeny=");
    expect(user).toContain("WantedBy=default.target");
  });

  test("root and self deploy restart the actor before the gateway", async () => {
    const deploy = await Bun.file(resolve(repoRoot, "deploy/deploy.sh")).text();
    const selfDeploy = await Bun.file(
      resolve(repoRoot, "deploy/self-deploy.sh"),
    ).text();
    expect(deploy).toContain("install-session-kernel-credential.sh");
    expect(deploy).toContain("opensession-session-kernel.service");
    const prepareFrontend = deploy.indexOf(
      'run_release prepare-frontend "$TARGET_COMMIT"',
    );
    const stopGateway = deploy.indexOf("systemctl stop opensession.service");
    const restartActor = deploy.indexOf(
      "systemctl restart opensession-session-kernel.service",
    );
    const publishGateway = deploy.indexOf('cp "$GATEWAY_UNIT_RENDERED"');
    expect(prepareFrontend).toBeGreaterThan(0);
    expect(prepareFrontend).toBeLessThan(stopGateway);
    expect(stopGateway).toBeGreaterThan(0);
    expect(restartActor).toBeGreaterThan(stopGateway);
    expect(publishGateway).toBeGreaterThan(restartActor);
    expect(restartActor).toBeLessThan(
      deploy.lastIndexOf("systemctl restart opensession.service"),
    );
    expect(selfDeploy).toContain("preflight_session_kernel");
    expect(selfDeploy).toContain(
      'curl -fs --max-time 2 "$SESSION_KERNEL_READY_URL"',
    );
    expect(selfDeploy).toContain("restore_gateway_on_exit");
    expect(selfDeploy).toContain("trap restore_gateway_on_exit EXIT");
    expect(selfDeploy).not.toContain(
      "[ ! -s /etc/opensession/session-kernel-token ]",
    );
    expect(selfDeploy.lastIndexOf("write_marker")).toBeLessThan(
      selfDeploy.lastIndexOf("stop_gateway"),
    );
    expect(selfDeploy).toContain("stop_gateway");
    expect(
      selfDeploy.lastIndexOf('prepare-frontend "$target_sha"'),
    ).toBeLessThan(selfDeploy.lastIndexOf("write_marker"));
    expect(selfDeploy.lastIndexOf("stop_gateway")).toBeLessThan(
      selfDeploy.lastIndexOf("refresh_session_kernel"),
    );
    expect(selfDeploy.lastIndexOf("refresh_session_kernel")).toBeLessThan(
      selfDeploy.lastIndexOf("restart_service"),
    );
  });

  test("frontend preparation failure cannot mutate live lifecycle state", async () => {
    const selfDeploy = await Bun.file(
      resolve(repoRoot, "deploy/self-deploy.sh"),
    ).text();
    const prepare = selfDeploy.indexOf(
      'release_dir="$(release_cmd prepare-frontend "$target_sha")"',
    );
    const failure = selfDeploy.indexOf(
      "release or frontend preparation failed",
      prepare,
    );
    const failureExit = selfDeploy.indexOf("exit 1", failure);
    for (const effect of [
      "preflight_session_kernel",
      "write_marker",
      "stop_gateway",
      'release_cmd switch "$target_sha"',
      "record_kernel_schema_floor",
    ]) {
      expect(selfDeploy.indexOf(effect, failureExit)).toBeGreaterThan(
        failureExit,
      );
    }
    expect(prepare).toBeGreaterThan(0);
    expect(failure).toBeGreaterThan(prepare);
    expect(failureExit).toBeGreaterThan(failure);
  });

  test("coordinated deploys replace peers while the supervisor listener stays live", async () => {
    const selfDeploy = await Bun.file(
      resolve(repoRoot, "deploy/self-deploy.sh"),
    ).text();
    const prepare = selfDeploy.indexOf("prepare-coordinated");
    const peers = selfDeploy.indexOf("refresh_protocol_peers", prepare);
    const activate = selfDeploy.indexOf("activate-coordinated", peers);
    expect(prepare).toBeGreaterThan(0);
    expect(peers).toBeGreaterThan(prepare);
    expect(activate).toBeGreaterThan(peers);
    expect(selfDeploy.slice(prepare, activate)).not.toContain("stop_gateway");
  });

  test("root rollouts reject duplicate, stale, and ordinary-release targets", async () => {
    const rootDeploy = await Bun.file(
      resolve(repoRoot, "deploy/deploy.sh"),
    ).text();
    expect(rootDeploy).toContain(
      "is already current; refusing a duplicate root rollout",
    );
    expect(rootDeploy).toContain("is not latest origin/main");
    expect(rootDeploy).toContain("changes no root-owned deployment artifacts");
    expect(rootDeploy).toContain(
      "use deploy_self so frontend and component impact classification applies",
    );
    expect(rootDeploy).toContain('exec 9<>"$DEPLOY_STATE/.lock"');
  });

  test("compatibility root rollouts cannot socket-activate a half-replaced gateway", async () => {
    const rootDeploy = await Bun.file(
      resolve(repoRoot, "deploy/deploy.sh"),
    ).text();
    const compatibility = rootDeploy.indexOf(
      "installed supervisor lacks fast service drain",
    );
    const stopCanary = rootDeploy.indexOf("stop_canary", compatibility);
    const stopGateway = rootDeploy.indexOf(
      "systemctl stop opensession.service",
      compatibility,
    );
    expect(compatibility).toBeGreaterThan(0);
    expect(stopCanary).toBeGreaterThan(compatibility);
    expect(stopGateway).toBeGreaterThan(stopCanary);
  });

  test("dedicated ingress survives ordinary gateway and peer replacement", async () => {
    const rootDeploy = await Bun.file(
      resolve(repoRoot, "deploy/deploy.sh"),
    ).text();
    const ingressUnit = await Bun.file(
      resolve(repoRoot, "opensession-ingress.service"),
    ).text();
    const gatewayUnit = await Bun.file(
      resolve(repoRoot, "opensession.service"),
    ).text();
    expect(rootDeploy).toContain("promoting dedicated stable ingress");
    expect(rootDeploy).toContain(
      "systemctl enable --now opensession-ingress.service",
    );
    expect(rootDeploy).toContain(
      'INGRESS_GENERATION="$(ingress_generation || true)"',
    );
    expect(rootDeploy).toContain('"$INGRESS_GENERATION" "$TARGET_COMMIT" --');
    expect(rootDeploy).toContain("gateway-tcp-proxy.ts");
    expect(ingressUnit).toContain("gateway-ingress.ts");
    expect(gatewayUnit).toContain(
      'Environment="OPENSESSION_EXTERNAL_INGRESS=1"',
    );
    expect(gatewayUnit).not.toContain("Sockets=opensession.socket");
  });

  test("root rollouts reuse the coordinated supervisor transaction when units are stable", async () => {
    const rootDeploy = await Bun.file(
      resolve(repoRoot, "deploy/deploy.sh"),
    ).text();
    const prepare = rootDeploy.indexOf("prepare-coordinated");
    const kernel = rootDeploy.indexOf(
      "restarting session kernel actor service",
      prepare,
    );
    const activate = rootDeploy.indexOf("activate-coordinated", kernel);
    const commit = rootDeploy.indexOf("commit-coordinated", activate);
    expect(prepare).toBeGreaterThan(0);
    expect(kernel).toBeGreaterThan(prepare);
    expect(activate).toBeGreaterThan(kernel);
    expect(commit).toBeGreaterThan(activate);
  });

  test("gateway-only deploys leave pointer promotion inside the supervisor transaction", async () => {
    const selfDeploy = await Bun.file(
      resolve(repoRoot, "deploy/self-deploy.sh"),
    ).text();
    const branch = selfDeploy.indexOf(
      'if [ "$release_impact" = "gateway-handoff" ]',
    );
    const handoff = selfDeploy.indexOf("gateway-supervisor.ts", branch);
    const branchEnd = selfDeploy.indexOf(
      "\n  fi\n\n  # Open the watchdog",
      handoff,
    );
    const gatewayBranch = selfDeploy.slice(branch, branchEnd);
    expect(branch).toBeGreaterThan(0);
    expect(handoff).toBeGreaterThan(branch);
    expect(branchEnd).toBeGreaterThan(handoff);
    expect(gatewayBranch).not.toContain('release_cmd switch "$target_sha"');
    expect(gatewayBranch).toContain("release_cmd current-sha");
  });

  test("supervises a separate minimal actor process on launchd", () => {
    const plist = renderSessionKernelPlist();
    const launcher = renderSessionKernelLauncher();
    const gatewayLauncher = renderLauncher();
    expect(plist).toContain("dev.opensession.session-kernel");
    expect(plist).toContain("OPENSESSION_SESSION_KERNEL_TOKEN_FILE");
    expect(plist).not.toContain("PLAIN_API_KEY");
    expect(plist).not.toContain("EnvironmentFile");
    expect(launcher).toContain("session-kernel-service.ts");
    expect(launcher).not.toContain("opensession.env");
    expect(gatewayLauncher).toContain("OPENSESSION_SESSION_KERNEL_TOKEN_FILE=");
  });

  test("renders the same credential into both sides of the gateway boundary", async () => {
    const gateway = await renderUnit("system");
    const actor = await renderSessionKernelUnit("system");
    const credential =
      "LoadCredential=session-kernel-token:/etc/opensession/session-kernel-token";
    expect(gateway).toContain(credential);
    expect(actor).toContain(credential);
  });
});
