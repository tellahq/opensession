import type { AutomationInput, AutomationOutput } from "../lib/api";
import { FIELD_LABEL, FORM_ROW, uniqueFlowId } from "../lib/automation-form";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input, Select } from "../ui/input";

export function AutomationDataFlowEditor({
  inputs,
  outputs,
  onInputsChange,
  onOutputsChange,
}: {
  inputs: AutomationInput[];
  outputs: AutomationOutput[];
  onInputsChange: (value: AutomationInput[]) => void;
  onOutputsChange: (value: AutomationOutput[]) => void;
}) {
  const updateInput = (index: number, value: AutomationInput) =>
    onInputsChange(inputs.map((input, at) => (at === index ? value : input)));
  const updateOutput = (index: number, value: AutomationOutput) =>
    onOutputsChange(
      outputs.map((output, at) => (at === index ? value : output)),
    );

  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <span className="text-label font-medium text-fg">Data flow</span>
        <span className="ml-2 text-label text-dim">
          Gather and flatten inputs before each run, then publish the result
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex min-h-10 items-center gap-2">
          <span className="text-label font-medium text-dim">Inputs</span>
          <span className="text-supporting text-faint">
            Each source is bounded and treated as untrusted data
          </span>
          <div className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              onClick={() =>
                onInputsChange([
                  ...inputs,
                  {
                    id: uniqueFlowId(
                      "slack",
                      inputs.map((input) => input.id),
                    ),
                    label: "Slack channel",
                    window: {
                      mode: "since_last_success",
                      minutes: 120,
                      overlapMinutes: 10,
                    },
                    reduce: { model: "claude-haiku-4-5", maxOutputChars: 8000 },
                    source: {
                      type: "slack_channel",
                      channel: "",
                      includeThreads: true,
                      includeBots: false,
                      limit: 200,
                    },
                  },
                ])
              }
            >
              + Slack
            </Button>
            <Button
              size="sm"
              onClick={() =>
                onInputsChange([
                  ...inputs,
                  {
                    id: uniqueFlowId(
                      "reports",
                      inputs.map((input) => input.id),
                    ),
                    label: "Previous reports",
                    source: { type: "reports", automationId: "self", limit: 3 },
                  },
                ])
              }
            >
              + Reports
            </Button>
          </div>
        </div>

        {inputs.length === 0 ? (
          <div className="rounded-panel border border-dashed border-line px-3 py-3 text-label text-faint">
            No collected inputs. The run receives only its instructions and
            trigger context.
          </div>
        ) : (
          inputs.map((input, index) => {
            const slack =
              input.source.type === "slack_channel" ? input.source : null;
            const reports =
              input.source.type === "reports" ? input.source : null;
            return (
              <div key={input.id} className="rounded-panel bg-surface p-3">
                <div className="mb-2 flex min-h-10 items-center gap-2">
                  <Select
                    className="max-w-[150px]"
                    value={input.source.type}
                    onChange={(e) => {
                      const source =
                        e.target.value === "slack_channel"
                          ? {
                              type: "slack_channel" as const,
                              channel: "",
                              includeThreads: true,
                              includeBots: false,
                              limit: 200,
                            }
                          : {
                              type: "reports" as const,
                              automationId: "self",
                              limit: 3,
                            };
                      updateInput(index, {
                        id: input.id,
                        label: input.label,
                        source,
                      });
                    }}
                  >
                    <option value="slack_channel">Slack channel</option>
                    <option value="reports">Report history</option>
                  </Select>
                  <Input
                    value={input.label || ""}
                    onChange={(e) =>
                      updateInput(index, { ...input, label: e.target.value })
                    }
                    placeholder="Label"
                  />
                  <Button
                    size="sm"
                    className="shrink-0 text-dim hover:text-red"
                    onClick={() =>
                      onInputsChange(inputs.filter((_, at) => at !== index))
                    }
                  >
                    Remove
                  </Button>
                </div>

                {slack && (
                  <>
                    <div className={FORM_ROW}>
                      <label className={FIELD_LABEL}>
                        Channel ID
                        <Input
                          className="mono-input"
                          value={slack.channel}
                          onChange={(e) =>
                            updateInput(index, {
                              ...input,
                              source: {
                                ...slack,
                                channel: e.target.value.toUpperCase(),
                              },
                            })
                          }
                          placeholder="C0123456789"
                        />
                      </label>
                      <label className={FIELD_LABEL}>
                        Initial lookback
                        <Input
                          type="number"
                          min={15}
                          max={10080}
                          value={input.window?.minutes ?? 120}
                          onChange={(e) =>
                            updateInput(index, {
                              ...input,
                              window: {
                                ...input.window,
                                minutes: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </label>
                      <label className={FIELD_LABEL}>
                        Reducer model
                        <Input
                          value={input.reduce?.model || ""}
                          onChange={(e) =>
                            updateInput(index, {
                              ...input,
                              reduce: {
                                ...input.reduce,
                                model: e.target.value,
                              },
                            })
                          }
                          placeholder="Default Haiku"
                        />
                      </label>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-label text-dim">
                      <label className="flex min-h-10 items-center gap-2">
                        <Checkbox
                          checked={slack.includeThreads !== false}
                          onCheckedChange={(checked) =>
                            updateInput(index, {
                              ...input,
                              source: { ...slack, includeThreads: checked },
                            })
                          }
                        />
                        Include thread replies
                      </label>
                      <label className="flex min-h-10 items-center gap-2">
                        <Checkbox
                          checked={slack.includeBots === true}
                          onCheckedChange={(checked) =>
                            updateInput(index, {
                              ...input,
                              source: { ...slack, includeBots: checked },
                            })
                          }
                        />
                        Include bot messages
                      </label>
                    </div>
                  </>
                )}

                {reports && (
                  <div className={FORM_ROW}>
                    <label className={FIELD_LABEL}>
                      Automation ID
                      <Input
                        className="mono-input"
                        value={reports.automationId}
                        onChange={(e) =>
                          updateInput(index, {
                            ...input,
                            source: {
                              ...reports,
                              automationId: e.target.value,
                            },
                          })
                        }
                        placeholder="self"
                      />
                    </label>
                    <label className={FIELD_LABEL}>
                      Reports to include
                      <Input
                        type="number"
                        min={1}
                        max={10}
                        value={reports.limit ?? 3}
                        onChange={(e) =>
                          updateInput(index, {
                            ...input,
                            source: {
                              ...reports,
                              limit: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="mt-1 flex flex-col gap-2">
        <div className="flex min-h-10 items-center gap-2">
          <span className="text-label font-medium text-dim">Outputs</span>
          <span className="text-supporting text-faint">
            Reports are durable; Slack delivery is optional
          </span>
          <div className="ml-auto flex gap-1.5">
            {!outputs.some((output) => output.type === "report") && (
              <Button
                size="sm"
                onClick={() =>
                  onOutputsChange([
                    ...outputs,
                    {
                      id: uniqueFlowId(
                        "report",
                        outputs.map((output) => output.id),
                      ),
                      type: "report",
                      enabled: true,
                      publish: "always",
                    },
                  ])
                }
              >
                + Report
              </Button>
            )}
            <Button
              size="sm"
              onClick={() =>
                onOutputsChange([
                  ...outputs,
                  {
                    id: uniqueFlowId(
                      "slack",
                      outputs.map((output) => output.id),
                    ),
                    type: "slack",
                    enabled: false,
                    channel: "",
                    minUrgency: "high",
                    minConfidence: "high",
                  },
                ])
              }
            >
              + Slack
            </Button>
          </div>
        </div>

        {outputs.length === 0 ? (
          <div className="rounded-panel border border-dashed border-line px-3 py-3 text-label text-faint">
            No required output. The run behaves like a normal automation
            session.
          </div>
        ) : (
          outputs.map((output, index) => (
            <div key={output.id} className="rounded-panel bg-surface p-3">
              <div className="flex min-h-10 items-center gap-2">
                <span className="w-[110px] shrink-0 text-label font-medium text-fg">
                  {output.type === "report" ? "Report" : "Slack"}
                </span>
                {output.type === "report" ? (
                  <Select
                    value={output.publish || "always"}
                    onChange={(e) =>
                      updateOutput(index, {
                        ...output,
                        publish:
                          e.target.value === "on_findings"
                            ? "on_findings"
                            : "always",
                      })
                    }
                  >
                    <option value="always">Publish every run</option>
                    <option value="on_findings">Only with findings</option>
                  </Select>
                ) : (
                  <>
                    <Input
                      className="mono-input"
                      value={output.channel}
                      onChange={(e) =>
                        updateOutput(index, {
                          ...output,
                          channel: e.target.value.toUpperCase(),
                        })
                      }
                      placeholder="C0123456789"
                    />
                    <label className="flex min-h-10 shrink-0 items-center gap-2 text-label text-dim">
                      <Checkbox
                        checked={output.enabled !== false}
                        onCheckedChange={(checked) =>
                          updateOutput(index, { ...output, enabled: checked })
                        }
                      />
                      Send
                    </label>
                  </>
                )}
                <Button
                  size="sm"
                  className="shrink-0 text-dim hover:text-red"
                  onClick={() =>
                    onOutputsChange(outputs.filter((_, at) => at !== index))
                  }
                >
                  Remove
                </Button>
              </div>
              {output.type === "slack" && (
                <div className="mt-2 grid grid-cols-2 gap-3 phone:grid-cols-1">
                  <label className={FIELD_LABEL}>
                    Minimum urgency
                    <Select
                      value={output.minUrgency || "high"}
                      onChange={(e) => {
                        const value = e.target.value;
                        updateOutput(index, {
                          ...output,
                          minUrgency:
                            value === "low" ||
                            value === "medium" ||
                            value === "critical"
                              ? value
                              : "high",
                        });
                      }}
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </Select>
                  </label>
                  <label className={FIELD_LABEL}>
                    Minimum confidence
                    <Select
                      value={output.minConfidence || "high"}
                      onChange={(e) => {
                        const value = e.target.value;
                        updateOutput(index, {
                          ...output,
                          minConfidence:
                            value === "low" || value === "medium"
                              ? value
                              : "high",
                        });
                      }}
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </Select>
                  </label>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
