/**
 * Files copied verbatim from the checkout into the compiled release artefact
 * next to the `opensession` binary.
 *
 * For a compiled install, `scripts/lib/service.ts` resolves every unit
 * template and installer it needs from the release directory (REPO_ROOT is
 * `dirname(process.execPath)` there), so anything it reads must be listed
 * here. `release-artefact.test.ts` cross-checks this list against the
 * templates `service.ts` actually opens; a template missing from this list
 * is the v0.4.52 bug where `opensession service install` died with
 * "missing socket unit template" on every published Linux release. The fix
 * for that was not to ship the socket: a compiled server binds its port
 * itself, so the installer no longer renders socket activation for it
 * (tellahq/opensession#297).
 */
export const RELEASE_SERVICE_TEMPLATES: readonly string[] = [
  "opensession.service",
  "opensession-executor.service",
  "opensession-session-kernel.service",
  "deploy/install-resource-control.sh",
  "deploy/install-executor-credential.sh",
  "deploy/install-session-kernel-credential.sh",
  "deploy/install-run-host-helper.sh",
  "deploy/opensession-run-host",
  "deploy/systemd/opensession-control.slice",
  "deploy/systemd/opensession-workloads.slice",
];

/**
 * Paths `service.ts` resolves from the release directory that are
 * deliberately NOT part of the tarball. Each entry needs a reason.
 */
export const RELEASE_TEMPLATE_EXEMPTIONS: ReadonlyMap<string, string> = new Map(
  [
    [
      "opensession-ingress.service",
      "source-install only: renderIngressUnit is skipped when isCompiledBinary()",
    ],
    [
      "opensession.socket",
      "source-install only: the compiled server binds its port directly, so renderSocketUnit is skipped when isCompiledBinary()",
    ],
    [
      "bin/bun",
      "install.sh places the runtime bun for source installs; the compiled binary embeds its own",
    ],
  ],
);
