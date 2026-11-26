/**
 * How client tools are presented to the Claude Agent SDK: every tool the
 * client (pi) declares is registered as an in-process SDK MCP tool under one
 * server name, and every SDK built-in is switched off, so the model can only
 * emit calls the client executes itself.
 *
 * A leaf module: the Claude host service (src/claude-host) imports it without
 * pulling in the account pool, audit log, or any other server state.
 */

import { z } from "zod";

/** Minimal JSON Schema → zod conversion for client tool registration. The
 *  schema only shapes what the model emits — Pi revalidates on its side,
 *  so unknown constructs safely degrade to z.any(). */
export function jsonSchemaToZodShape(
  schema: any,
): Record<string, z.ZodTypeAny> {
  if (!schema || typeof schema !== "object" || !schema.properties) return {};
  const required = new Set<string>(
    Array.isArray(schema.required) ? schema.required : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries<any>(schema.properties)) {
    let t = jsonSchemaToZod(prop);
    if (prop?.description && typeof prop.description === "string")
      t = t.describe(prop.description);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}

function jsonSchemaToZod(schema: any): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any();
  switch (schema.type) {
    case "string":
      return Array.isArray(schema.enum) && schema.enum.length
        ? z.enum(schema.enum as [string, ...string[]])
        : z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(jsonSchemaToZod(schema.items));
    case "object":
      return schema.properties
        ? z.object(jsonSchemaToZodShape(schema))
        : z.record(z.string(), z.any());
    default:
      return z.any();
  }
}

export const PASSTHROUGH_MCP = "oc";
export const PASSTHROUGH_PREFIX = `mcp__${PASSTHROUGH_MCP}__`;

/** Primary switch: an empty `tools` list removes every SDK built-in from the
 *  model's context, including ones added by SDK bumps after the denylist
 *  below was written (CronCreate, ScheduleWakeup, Monitor, ...). Without it a
 *  new built-in leaks into context, the model calls it, and the client
 *  answers "Tool X not found". */
export const SDK_BUILTIN_TOOLS: string[] = [];

/** Built-in SDK tools the bridge must never let run — the client owns all
 *  execution. Belt-and-braces under `SDK_BUILTIN_TOOLS`; the PreToolUse hook
 *  blocks everything as a final backstop. */
export const DISALLOWED_BUILTINS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "Task",
  "TaskOutput",
  "TaskStop",
  "Agent",
  "Skill",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "AskUserQuestion",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ToolSearch",
  "Workflow",
];
