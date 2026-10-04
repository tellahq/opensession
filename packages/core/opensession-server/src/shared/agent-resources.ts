/** CPU is percent of one core; RSS sums resident pages, including shared pages. */
export interface ResourceProcess {
  pid: number;
  ppid: number;
  start: string;
  bornAt?: number;
  cpuMs: number;
  rss: number;
}
export interface ResourceRoot {
  pid: number;
  sessionId: string;
  runId: string;
  kind: "agent" | "script" | "portal" | "shell";
  start?: string;
  startedAt?: number;
}
export interface AgentResourceSample {
  at: number;
  host: { cpu: number | null; usedMemory: number; totalMemory: number };
  runs: Array<ResourceRoot & { cpu: number; rss: number; processes: number }>;
}
export type AgentResourceEvent =
  | { status: "ready"; sample: AgentResourceSample }
  | { status: "unavailable" };
