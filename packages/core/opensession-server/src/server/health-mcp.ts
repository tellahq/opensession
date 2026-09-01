/**
 * `opensession-health` — read this instance's own health.
 *
 * One tool, no arguments, no writes. It returns the same shape /api/health
 * serves: the `system` block from system-stats.ts plus each registered
 * agent's self-reported health, so the health monitor reads exactly the
 * numbers a human reads in the browser.
 *
 * Why a tool and not a fetch. The monitor is an unattended automation, and an
 * automation genuinely cannot reach its own host over HTTP: web-fetch.ts
 * refuses loopback and private addresses on every hop by design, because its
 * caller is a model reading untrusted text, and no engine gives an unattended
 * ask run a shell to curl with. Before this existed the monitor's only path
 * was the Pi engine's webfetch tool, so moving automations to Pi
 * (aeb73d59f) blinded it while its runs kept recording `ok`.
 *
 * Held to the automation in-process bar, same as opensession-turn and
 * opensession-papercuts: it reads aggregate host counters and nothing else.
 * No path, url or command is accepted, so untrusted text cannot steer it, and
 * there is nothing here to escalate with. Never grow this server past that.
 */

import { createSdkMcpServer, tool } from "./inprocess-mcp";
import { activeAgentRunCount } from "./agent-runner";
import { getAgents } from "./agents-registry";
import { systemStats } from "./system-stats";

/** Each registered agent's own health report, keyed by agent name — the same
 *  map /api/health returns. An agent that throws is reported as such rather
 *  than taking the whole read down with it. */
function agentHealth(): Record<string, unknown> {
  const health: Record<string, unknown> = {};
  for (const a of getAgents()) {
    try {
      health[a.name] = a.health();
    } catch (e) {
      health[a.name] = {
        status: "error",
        error: String((e as Error)?.message || e),
      };
    }
  }
  return health;
}

export function createHealthMcpServer() {
  const tools = [
    tool(
      "read_host_metrics",
      "Read this instance's health: disk usage on /, memory and swap, load averages against core count, counts of the process fleets that have leaked before (detached run hosts, MCP proxies, headless Chrome, dev stacks, git operations), cgroup memory accounting, and each agent's status. Returns the same fields as the health endpoint. Use it for a health check instead of trying to fetch the server over HTTP, which is refused for loopback addresses.",
      {},
      async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                uptimeSeconds: Math.round(process.uptime()),
                activeRuns: activeAgentRunCount(),
                agents: agentHealth(),
                system: systemStats(),
              },
              null,
              2,
            ),
          },
        ],
      }),
    ),
  ];
  return createSdkMcpServer({
    name: "opensession-health",
    version: "1.0.0",
    tools,
  });
}
