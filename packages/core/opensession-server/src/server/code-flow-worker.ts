import {
  analyzeCodeFlow,
  type CodeFlowAnalysisInput,
} from "./code-flow-analyzer";

declare const self: Worker;

self.onmessage = (event: MessageEvent<CodeFlowAnalysisInput>) => {
  try {
    const result = analyzeCodeFlow(event.data);
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024)
      throw new Error("Code-flow result exceeded its limit");
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({
      ok: false,
      error:
        error instanceof Error ? error.message : "Code-flow analysis failed",
    });
  }
};
