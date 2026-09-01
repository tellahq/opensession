import { describe, expect, test } from "bun:test";
import type { SetupStatus } from "../components/setup-shared";
import {
  SETUP_WIDGET_VISIBLE_ITEM_LIMIT,
  setupWidgetItems,
  visibleSetupWidgetItems,
} from "./setup-widget";

const status: SetupStatus = {
  publicBaseUrl: "http://127.0.0.1:3850",
  access: {
    publicBaseUrl: "http://127.0.0.1:3850",
    port: 3850,
    tailnetIp: null,
    caddyInstalled: false,
  },
  repos: [],
  engine: {
    claudeBin: null,
    claudeAccounts: 0,
    codexAccounts: 0,
    defaultModel: "",
    ready: false,
    blocker: null,
    fix: null,
    fixableInApp: false,
  },
  team: { count: 1, names: ["Kent"] },
  github: {
    userPrAuth: false,
    clientIdConfigured: false,
    clientSecretConfigured: false,
    mentionHandle: "",
    appCredentialConfigured: false,
    privateKeyConfigured: false,
    appSlug: null,
    installationOwner: null,
    appCreateUrl: "",
  },
  integrations: [
    {
      id: "github",
      label: "GitHub",
      doc: "",
      enabled: true,
      env: [],
      links: [],
      missingRequired: [],
    },
  ],
};

function completion(overrides: Partial<SetupStatus> = {}, hasSession = false) {
  return Object.fromEntries(
    setupWidgetItems({ ...status, ...overrides }, hasSession).map((item) => [
      item.id,
      item.complete,
    ]),
  );
}

describe("sidebar setup checklist", () => {
  test("starts with only the already-created server complete", () => {
    expect(completion()).toEqual({
      server: true,
      github: false,
      models: false,
      repository: false,
      domain: false,
      tools: false,
      members: false,
      session: false,
    });
  });

  test("tracks the first useful setup milestones", () => {
    const connectedTool = {
      id: "linear",
      label: "Linear",
      doc: "",
      enabled: true,
      env: [],
      links: [],
      missingRequired: [],
    };
    expect(
      completion(
        {
          access: {
            ...status.access,
            publicBaseUrl: "https://sessions.example.com",
          },
          github: {
            ...status.github,
            appCredentialConfigured: true,
            appSlug: "open-session",
          },
          engine: { ...status.engine, ready: true },
          repos: [
            {
              id: "repo",
              label: "Repo",
              path: "/repo",
              defaultBranch: "main",
              isolatedWorktrees: true,
              lifecycle: {
                dir: null,
                setup: false,
                start: false,
                previewJson: false,
                previewCommand: false,
              },
            },
          ],
          team: { count: 2, names: ["Kent", "Sam"] },
          integrations: [...status.integrations, connectedTool],
        },
        true,
      ),
    ).toEqual({
      server: true,
      github: true,
      models: true,
      repository: true,
      domain: true,
      tools: true,
      members: true,
      session: true,
    });
  });

  test("folds completed steps and limits the compact widget", () => {
    const items = setupWidgetItems(status, false);
    expect(visibleSetupWidgetItems(items).map((item) => item.id)).toEqual([
      "github",
      "models",
      "repository",
    ]);
    expect(visibleSetupWidgetItems(items)).toHaveLength(
      SETUP_WIDGET_VISIBLE_ITEM_LIMIT,
    );
  });

  test("does not count GitHub or a tool missing credentials as connected tools", () => {
    expect(
      completion({
        integrations: [
          ...status.integrations,
          {
            id: "slack",
            label: "Slack",
            doc: "",
            enabled: true,
            env: [],
            links: [],
            missingRequired: ["SLACK_BOT_TOKEN"],
          },
        ],
      }).tools,
    ).toBe(false);
  });
});
