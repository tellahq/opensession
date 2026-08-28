#!/usr/bin/env bun
import { runAgentHost } from "./runtime";

export interface AgentHostArguments {
  readonly generation: string;
  readonly expectedGatewayUid: number;
  readonly expectedHostUid: number;
  readonly doctor: boolean;
}

export function parseAgentHostArguments(argv: readonly string[]): AgentHostArguments {
  let generation: string | undefined;
  let expectedGatewayUid: number | undefined;
  let expectedHostUid: number | undefined;
  let doctor = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--doctor" && !doctor) doctor = true;
    else if (argument === "--generation" && generation === undefined) generation = argv[++index];
    else if (argument === "--expected-gateway-uid" && expectedGatewayUid === undefined) expectedGatewayUid = Number(argv[++index]);
    else if (argument === "--expected-host-uid" && expectedHostUid === undefined) expectedHostUid = Number(argv[++index]);
    else throw new Error("Invalid Agent Host arguments");
  }
  if (!generation || !Number.isSafeInteger(expectedGatewayUid) || expectedGatewayUid! <= 0 ||
      !Number.isSafeInteger(expectedHostUid) || expectedHostUid! <= 0)
    throw new Error("Agent Host generation and service UIDs are required");
  return Object.freeze({
    generation,
    expectedGatewayUid: expectedGatewayUid!,
    expectedHostUid: expectedHostUid!,
    doctor,
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  await runAgentHost(parseAgentHostArguments(argv));
}

if (import.meta.main) {
  main().catch(() => {
    // Startup fails closed. Credential values and nested causes are never logged.
    console.error("Open Session Agent Host startup failed");
    process.exit(1);
  });
}
