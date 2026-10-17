#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { buildUnsigned, doctor, inspectIpa, runSwiftTests } from "./build";
import { inspectProject } from "./project";
import { createBuildPlan, createStorePlan, createUploadPlan } from "./plans";
import { loadConfig } from "./config";
import { ascClient } from "./asc";
import { appStatus, distributeTestFlight, registerBundleId } from "./app-store";
import { createApp } from "./scaffold";
import { resolveProjectDir } from "./security";
import { executePlan, safePlanView } from "./release";

function modeFrom(args: string[]): "build" | "release" {
  const index = args.indexOf("--mode");
  const mode = index >= 0 ? args[index + 1] : "build";
  if (mode !== "build" && mode !== "release") {
    throw new Error("--mode must be build or release");
  }
  return mode;
}

type Args = Record<string, unknown>;
const string = (
  args: Args,
  key: string,
  required = true,
): string | undefined => {
  const value = args[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value)
    throw new Error(`${key} must be a non-empty string`);
  return value;
};
const boolean = (args: Args, key: string, fallback = false): boolean => {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be boolean`);
  return value;
};

const projectProperty = {
  projectDir: {
    type: "string",
    description: "Absolute path to the app project or worktree",
  },
};
const buildTools: Tool[] = [
  {
    name: "apple_mobile_create_app",
    description:
      "Create a new SwiftUI app in an empty directory: XcodeGen project.yml, sources, tests, asset catalog, and .opensession/apple-mobile.json. Writes files only; no Apple account calls.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Absolute path of a new or empty directory",
        },
        name: { type: "string", description: "Display name, e.g. Acme Notes" },
        bundleId: { type: "string", description: "e.g. com.example.AcmeNotes" },
        teamId: { type: "string", description: "Apple Developer Team ID" },
        platform: {
          type: "string",
          enum: ["ios", "macos"],
          description:
            "Default ios. macOS apps build, but cannot be released yet.",
        },
        deploymentTarget: { type: "string" },
      },
      required: ["projectDir", "name", "bundleId"],
    },
  },
  {
    name: "apple_mobile_doctor",
    description:
      "Inspect host Apple/Swift/xtool capabilities without changing anything.",
    inputSchema: {
      type: "object",
      properties: { projectDir: { type: "string" } },
    },
  },
  {
    name: "apple_mobile_inspect_project",
    description:
      "Validate .opensession/apple-mobile.json and inspect the project/revision.",
    inputSchema: {
      type: "object",
      properties: projectProperty,
      required: ["projectDir"],
    },
  },
  {
    name: "apple_mobile_test",
    description:
      "Run swift test in a configured Swift package. No signing or upload.",
    inputSchema: {
      type: "object",
      properties: projectProperty,
      required: ["projectDir"],
    },
  },
  {
    name: "apple_mobile_build_unsigned",
    description:
      "Build with xtool or Xcode without signing. xtool can optionally emit an IPA.",
    inputSchema: {
      type: "object",
      properties: {
        ...projectProperty,
        configuration: { type: "string", enum: ["debug", "release"] },
        ipa: { type: "boolean" },
      },
      required: ["projectDir"],
    },
  },
  {
    name: "apple_mobile_inspect_ipa",
    description:
      "Read version/bundle metadata and SHA-256 from an IPA inside the project.",
    inputSchema: {
      type: "object",
      properties: {
        ...projectProperty,
        artifactPath: {
          type: "string",
          description: "Project-relative IPA path",
        },
      },
      required: ["projectDir", "artifactPath"],
    },
  },
];
const releaseTools: Tool[] = [
  {
    name: "apple_release_doctor",
    description:
      "Inspect release prerequisites and credential presence without revealing credentials.",
    inputSchema: {
      type: "object",
      properties: { projectDir: { type: "string" } },
    },
  },
  {
    name: "apple_release_app_status",
    description:
      "Read-only App Store Connect status for the configured app: bundle ID, app record, recent builds and their processing state, App Store versions, TestFlight groups, and next steps.",
    inputSchema: {
      type: "object",
      properties: projectProperty,
      required: ["projectDir"],
    },
  },
  {
    name: "apple_release_register_bundle_id",
    description:
      "Register the configured bundle ID in the Apple Developer account if it is missing. Idempotent. Does not create the App Store Connect app record, which Apple's API cannot do.",
    inputSchema: {
      type: "object",
      properties: {
        ...projectProperty,
        name: { type: "string", description: "Bundle ID display name" },
      },
      required: ["projectDir"],
    },
  },
  {
    name: "apple_release_testflight_distribute",
    description:
      "For a processed build: set its What to Test notes and add it to internal TestFlight groups. External groups need Beta App Review and are refused.",
    inputSchema: {
      type: "object",
      properties: {
        ...projectProperty,
        buildNumber: { type: "string" },
        marketingVersion: { type: "string" },
        whatToTest: { type: "string" },
        groups: { type: "array", items: { type: "string" } },
        locale: { type: "string", description: "Default en-US" },
      },
      required: ["projectDir", "buildNumber"],
    },
  },
  {
    name: "apple_release_plan_submit",
    description:
      "Create a one-hour, commit-bound plan to submit a processed build for App Review: creates or updates the App Store version, attaches the build, and submits. Store metadata and screenshots must already be complete. Does not submit.",
    inputSchema: {
      type: "object",
      properties: {
        ...projectProperty,
        marketingVersion: { type: "string" },
        buildNumber: { type: "string" },
        releaseType: {
          type: "string",
          enum: ["manual", "after_approval"],
          description:
            "manual (default) needs a later release plan; after_approval goes live as soon as Apple approves",
        },
        whatsNew: { type: "string" },
      },
      required: ["projectDir", "marketingVersion", "buildNumber"],
    },
  },
  {
    name: "apple_release_plan_store_release",
    description:
      "Create a one-hour, commit-bound plan to release an approved version that is waiting for developer release. Does not release.",
    inputSchema: {
      type: "object",
      properties: {
        ...projectProperty,
        marketingVersion: { type: "string" },
      },
      required: ["projectDir", "marketingVersion"],
    },
  },
  {
    name: "apple_release_plan_adhoc",
    description:
      "Create a one-hour, commit-bound plan for an Xcode ad-hoc export. Does not build or sign.",
    inputSchema: {
      type: "object",
      properties: {
        ...projectProperty,
        marketingVersion: { type: "string" },
        buildNumber: {
          type: "string",
          description:
            "Omit to use one above the highest build in App Store Connect",
        },
      },
      required: ["projectDir"],
    },
  },
  {
    name: "apple_release_plan_testflight",
    description:
      "Create a one-hour, commit-bound plan for Xcode archive/export/TestFlight upload. Does not upload.",
    inputSchema: {
      type: "object",
      properties: {
        ...projectProperty,
        marketingVersion: { type: "string" },
        buildNumber: {
          type: "string",
          description:
            "Omit to use one above the highest build in App Store Connect",
        },
      },
      required: ["projectDir"],
    },
  },
  {
    name: "apple_release_plan_upload",
    description:
      "Create a one-hour plan bound to the commit and SHA-256 of an existing IPA. Execution requires Xcode command-line tools on macOS.",
    inputSchema: {
      type: "object",
      properties: {
        ...projectProperty,
        artifactPath: { type: "string" },
      },
      required: ["projectDir", "artifactPath"],
    },
  },
  {
    name: "apple_release_execute",
    description:
      "Execute a plan after a later authenticated human approval (the card under the plan in the session, or Settings → Integrations → Apple mobile). confirmation must exactly equal its full commit SHA.",
    inputSchema: {
      type: "object",
      properties: {
        ...projectProperty,
        planId: { type: "string" },
        confirmation: {
          type: "string",
          description: "Full planned git commit SHA",
        },
      },
      required: ["projectDir", "planId", "confirmation"],
    },
  },
];

function reviewablePlan<T extends { plan: Parameters<typeof safePlanView>[0] }>(
  result: T,
) {
  return {
    ...result,
    plan: safePlanView(result.plan),
    approvalRequired: true,
    approvalLocation:
      "The approval card under this tool call in the session, or Settings → Integrations → Apple mobile",
  };
}

const strings = (args: Args, key: string): string[] | undefined => {
  const value = args[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item)
  )
    throw new Error(`${key} must be an array of non-empty strings`);
  return value as string[];
};

async function projectApp(args: Args) {
  const projectDir = resolveProjectDir(string(args, "projectDir")!);
  const { config } = await loadConfig(projectDir);
  return { projectDir, config, client: ascClient(projectDir) };
}

async function call(name: string, args: Args): Promise<unknown> {
  switch (name) {
    case "apple_mobile_create_app":
      return createApp({
        projectDir: string(args, "projectDir")!,
        name: string(args, "name")!,
        bundleId: string(args, "bundleId")!,
        teamId: string(args, "teamId", false),
        platform: string(args, "platform", false) as
          | "ios"
          | "macos"
          | undefined,
        deploymentTarget: string(args, "deploymentTarget", false),
      });
    case "apple_release_app_status": {
      const { config, client } = await projectApp(args);
      return appStatus(client, {
        bundleId: config.bundleId,
        platform: config.platform,
      });
    }
    case "apple_release_register_bundle_id": {
      const { config, client } = await projectApp(args);
      return registerBundleId(client, {
        identifier: config.bundleId,
        name:
          string(args, "name", false) ??
          config.xcode?.scheme ??
          config.bundleId,
        platform: config.platform,
      });
    }
    case "apple_release_testflight_distribute": {
      const { config, client } = await projectApp(args);
      return distributeTestFlight(client, {
        bundleId: config.bundleId,
        platform: config.platform,
        buildNumber: string(args, "buildNumber")!,
        marketingVersion: string(args, "marketingVersion", false),
        whatToTest: string(args, "whatToTest", false),
        groups: strings(args, "groups"),
        locale: string(args, "locale", false),
      });
    }
    case "apple_release_plan_submit":
      return reviewablePlan(
        await createStorePlan(string(args, "projectDir")!, "submit", {
          marketingVersion: string(args, "marketingVersion")!,
          buildNumber: string(args, "buildNumber")!,
          releaseType: string(args, "releaseType", false) as
            | "manual"
            | "after_approval"
            | undefined,
          whatsNew: string(args, "whatsNew", false),
        }),
      );
    case "apple_release_plan_store_release":
      return reviewablePlan(
        await createStorePlan(string(args, "projectDir")!, "release", {
          marketingVersion: string(args, "marketingVersion")!,
        }),
      );
    case "apple_mobile_doctor":
    case "apple_release_doctor":
      return doctor(string(args, "projectDir", false));
    case "apple_mobile_inspect_project":
      return inspectProject(string(args, "projectDir")!);
    case "apple_mobile_test":
      return runSwiftTests(string(args, "projectDir")!);
    case "apple_mobile_build_unsigned":
      return buildUnsigned(
        string(args, "projectDir")!,
        string(args, "configuration", false) as "debug" | "release" | undefined,
        boolean(args, "ipa"),
      );
    case "apple_mobile_inspect_ipa":
      return inspectIpa(
        string(args, "projectDir")!,
        string(args, "artifactPath")!,
      );
    case "apple_release_plan_adhoc": {
      const result = await createBuildPlan(
        string(args, "projectDir")!,
        "adhoc",
        {
          marketingVersion: string(args, "marketingVersion", false),
          buildNumber: string(args, "buildNumber", false),
        },
      );
      return reviewablePlan(result);
    }
    case "apple_release_plan_testflight": {
      const result = await createBuildPlan(
        string(args, "projectDir")!,
        "testflight",
        {
          marketingVersion: string(args, "marketingVersion", false),
          buildNumber: string(args, "buildNumber", false),
        },
      );
      return reviewablePlan(result);
    }
    case "apple_release_plan_upload": {
      const result = await createUploadPlan(
        string(args, "projectDir")!,
        string(args, "artifactPath")!,
      );
      return reviewablePlan(result);
    }
    case "apple_release_execute":
      return executePlan(
        string(args, "projectDir")!,
        string(args, "planId")!,
        string(args, "confirmation")!,
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function startAppleMobileServer(args = process.argv.slice(2)) {
  const mode = modeFrom(args);
  process.env.APPLE_MOBILE_MCP_MODE = mode;
  const server = new Server(
    { name: `opensession-apple-${mode}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mode === "build" ? buildTools : releaseTools,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await call(
        request.params.name,
        (request.params.arguments ?? {}) as Args,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) await startAppleMobileServer();
