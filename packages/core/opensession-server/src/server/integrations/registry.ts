/**
 * The integration registry: one declarative entry per optional integration.
 *
 * Before this existed, every integration was an if-block hand-written into
 * `loadAgents()` in opensession.ts, and its environment variables were
 * documented only in prose. That made three things awkward: onboarding could
 * not enumerate integrations, `opensession doctor` could not tell you which
 * credentials were missing, and adding one meant editing the entry file that
 * every parallel session is already touching.
 *
 * Each entry owns its identity (config key + env flag), its credentials, and
 * how to construct its agent. `loadAgents()` is now a loop over this array.
 *
 * Adding an integration: append an entry here. Nothing in opensession.ts
 * changes. This is a boot path, so it needs a real `systemctl restart`.
 *
 * ARRAY ORDER IS BOOT ORDER. It matches the original hand-written sequence
 * (plain, linear, slack, stripe, grafana, github) so that agent
 * registration — including webhook route registration — happens in exactly the
 * order it always has. Present them in a friendlier order in UI if you like,
 * but do not reshuffle this array casually.
 *
 * Other invariants preserved from the original blocks:
 *  - a failing import logs and is skipped; it never takes the server down
 *  - `always: true` modules load regardless of config and self-gate internally
 *  - `requires` is an extra runtime gate on top of the enable flag
 */

import type { AgentModule } from "../../agents/types";
import { codeStorageConfig } from "../config";

/** Passed to integrations that need to poke core state when they act. */
export type IntegrationContext = {
  onSessionInvalidate: () => void;
};

export type IntegrationEnv = {
  name: string;
  /** Placeholder written into a generated env file. */
  example?: string;
  /** Without this the integration cannot function at all. */
  required?: boolean;
  /** Required only when another credential is absent. */
  requiredWhen?: (present: (name: string) => boolean) => boolean;
  description: string;
};

/** Resolve conditional and unconditional credential requirements consistently. */
export function envRequired(
  env: IntegrationEnv,
  present: (name: string) => boolean,
): boolean {
  return env.requiredWhen ? env.requiredWhen(present) : !!env.required;
}

export type IntegrationLink = {
  label: string;
  url: string;
};

export type IntegrationSpec = {
  /** Config key under `integrations.` and the id used by the CLI. */
  id: string;
  label: string;
  /** Doc path, surfaced by onboarding and in the generated env file. */
  doc: string;
  enableFlag: string;
  env: IntegrationEnv[];
  /** Where in the third-party tool the credentials are created — surfaced as
   *  deep links by Settings → Setup. Static only; instance-dependent links
   *  (Grafana's own URL, the GitHub org) are computed in the setup route. */
  links?: IntegrationLink[];
  /** Load regardless of configuration; the module gates itself. */
  always?: boolean;
  /** Extra gate beyond the enable flag — checked at load time. */
  requires?: () => boolean;
  load: (ctx: IntegrationContext) => Promise<AgentModule>;
};

export const INTEGRATIONS: IntegrationSpec[] = [
  {
    id: "plain",
    label: "Plain",
    doc: "docs/setup/plain.md",
    enableFlag: "ENABLE_PLAIN_AGENT",
    env: [
      {
        name: "PLAIN_API_KEY",
        required: true,
        description: "API key for thread reads/writes",
      },
      {
        name: "PLAIN_WEBHOOK_SECRET",
        description: "verifies inbound webhook signatures",
      },
    ],
    links: [
      // Plain's settings URLs are workspace-scoped after login; this lands on
      // the right page or the login that leads there.
      {
        label: "Plain → Settings → Machine users",
        url: "https://app.plain.com/settings/machine-users",
      },
      {
        label: "API key guide",
        url: "https://www.plain.com/docs/graphql/authentication",
      },
    ],
    load: async () => {
      const { PlainAgent } = await import("../../agents/plain/index");
      return new PlainAgent();
    },
  },
  {
    id: "linear",
    label: "Linear",
    doc: "docs/setup/linear.md",
    enableFlag: "ENABLE_LINEAR_AGENT",
    env: [
      {
        name: "LINEAR_API_KEY",
        required: true,
        description: "API key for issue reads/writes",
      },
      {
        name: "LINEAR_WEBHOOK_SECRET",
        description: "verifies inbound webhook signatures",
      },
      { name: "LINEAR_CLIENT_ID", description: "OAuth app client id" },
      { name: "LINEAR_CLIENT_SECRET", description: "OAuth app client secret" },
    ],
    links: [
      {
        label: "Create API key (Security & access)",
        url: "https://linear.app/settings/account/security",
      },
      { label: "OAuth applications", url: "https://linear.app/settings/api" },
    ],
    load: async () => {
      const { LinearAgent } = await import("../../agents/linear/index");
      return new LinearAgent();
    },
  },
  {
    id: "slack",
    label: "Slack",
    doc: "docs/setup/slack.md",
    enableFlag: "ENABLE_SLACK_AGENT",
    env: [
      {
        name: "SLACK_BOT_TOKEN",
        example: "xoxb-",
        required: true,
        description: "bot user token",
      },
      {
        name: "SLACK_APP_TOKEN",
        example: "xapp-",
        description: "app-level token with connections:write for Socket Mode",
      },
      {
        name: "SLACK_SIGNING_SECRET",
        requiredWhen: (present) => !present("SLACK_APP_TOKEN"),
        description: "signing secret for HTTP event requests",
      },
      {
        name: "ALLOWED_SLACK_USER_ID",
        description: "restricts admin tools to one user",
      },
      {
        name: "WORKTREE_HOOK_SECRET",
        description: "shared secret for worktree hooks",
      },
    ],
    links: [{ label: "Create Slack app", url: "https://api.slack.com/apps" }],
    load: async () => {
      const { SlackAgent } = await import("../../agents/slack/index");
      return new SlackAgent();
    },
  },
  {
    id: "stripe",
    label: "Stripe",
    doc: "docs/setup/integrations-misc.md#stripe",
    enableFlag: "ENABLE_STRIPE_AGENT",
    env: [
      {
        name: "STRIPE_WEBHOOK_SECRET",
        required: true,
        description: "verifies inbound webhook signatures",
      },
    ],
    links: [
      {
        label: "Webhook endpoints",
        url: "https://dashboard.stripe.com/webhooks",
      },
      {
        label: "API keys (restricted)",
        url: "https://dashboard.stripe.com/apikeys",
      },
    ],
    // Without the signing secret every webhook fails verification, so there is
    // no point exposing the route at all.
    requires: () => Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    load: async () => {
      const { StripeAgent } = await import("../../agents/stripe/index");
      return new StripeAgent();
    },
  },
  {
    id: "grafana",
    label: "Grafana poller",
    doc: "docs/setup/integrations-misc.md#grafana-poller",
    enableFlag: "ENABLE_GRAFANA_POLLER",
    env: [
      { name: "GRAFANA_URL", required: true, description: "Grafana base URL" },
      {
        name: "GRAFANA_SERVICE_ACCOUNT_TOKEN",
        required: true,
        description: "service account token",
      },
      { name: "LOKI_DATASOURCE_UID", description: "Loki datasource to query" },
    ],
    load: async (ctx) => {
      const { GrafanaPollerAgent } =
        await import("../../agents/grafana-poller/index");
      return new GrafanaPollerAgent({
        onSessionInvalidate: ctx.onSessionInvalidate,
      });
    },
  },
  {
    id: "github",
    label: "GitHub",
    doc: "docs/setup/github.md",
    enableFlag: "ENABLE_GITHUB_AGENT",
    env: [
      {
        name: "GITHUB_WEBHOOK_SECRET",
        description: "verifies inbound webhook signatures",
      },
      {
        name: "GITHUB_MENTION_HANDLES",
        description: "additional handles that trigger the PR agent",
      },
    ],
    load: async (ctx) => {
      const { GithubAgent } = await import("../../agents/github/index");
      return new GithubAgent({ onSessionInvalidate: ctx.onSessionInvalidate });
    },
  },
  {
    id: "codestorage",
    label: "code.storage",
    doc: "docs/setup/codestorage.md",
    enableFlag: "ENABLE_CODESTORAGE",
    // No credentials in env: the customer-signed JWT key lives at
    // `integrations.codeStorage.privateKeyPath`, so config presence is the
    // only requirement.
    env: [],
    links: [{ label: "code.storage docs", url: "https://code.storage/docs" }],
    // The agent module is a no-op shell; the real support (repo host, JWT
    // minting, REST client) activates on config presence alone.
    requires: () => codeStorageConfig() !== null,
    load: async () => {
      const { CodeStorageIntegration } =
        await import("../codestorage/integration");
      return new CodeStorageIntegration();
    },
  },
];

export function findIntegration(id: string): IntegrationSpec | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}
