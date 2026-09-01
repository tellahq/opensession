import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./shared/atomic-write";

export function gatewayBackendSelectionPath(deployState: string): string {
  return join(deployState, "gateway-backend-port");
}

export function publishGatewayBackendPort(
  deployState: string,
  port: number,
): void {
  const selected =
    Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 0;
  writeFileAtomic(
    gatewayBackendSelectionPath(deployState),
    `${selected}\n`,
    0o600,
  );
}

export function readGatewayBackendPort(deployState: string): number {
  try {
    const value = Number(
      readFileSync(gatewayBackendSelectionPath(deployState), "utf8").trim(),
    );
    return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : 0;
  } catch {
    return 0;
  }
}
