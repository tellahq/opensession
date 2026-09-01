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
import { createBuildPlan, createUploadPlan } from "./plans";
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
    name: "apple_release_plan_adhoc",
    description:
      "Create a one-hour, commit-bound plan for an Xcode ad-hoc export. Does not build or sign.",
    inputSchema: {
      type: "object",
      properties: {
        ...projectProperty,
        marketingVersion: { type: "string" },
        buildNumber: { type: "string" },
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
        buildNumber: { type: "string" },
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
      "Execute a plan after a later authenticated human approval in Settings → Integrations → Apple mobile. confirmation must exactly equal its full commit SHA.",
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
    approvalLocation: "Settings → Integrations → Apple mobile",
  };
}

async function call(name: string, args: Args): Promise<unknown> {
  switch (name) {
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
