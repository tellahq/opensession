import { audit } from "../audit";
import { neutralizeContextSentinels, wrapContext } from "../prompt-context";
import { ensureMemoryV2Ready, memoryRolloutMode } from "./runtime";
import {
  RETRIEVED_MEMORY_BUDGET_BYTES,
  renderAmbientMemory,
  retrieveMemory,
  type RetrievalRecord,
} from "./retrieval";
import type { MemoryStore } from "./store";
import type { MemoryRecord } from "./types";

export interface PromptMemoryScopes {
  scopeKeys: string[];
  primaryRepoKey?: string;
}

export interface PromptMemoryResult {
  text: string;
  ids: string[];
  bytes: number;
  omitted: number;
}

function pinnedRecords(
  store: MemoryStore,
  scopeKeys: string[],
): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = store.list(
      { scopeKeys, states: ["active"], tiers: ["pinned"] },
      { cursor, limit: 100 },
    );
    records.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return records;
}

function matchingRecords(
  store: MemoryStore,
  scopeKeys: string[],
  query: string,
): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = store.search(query, {
      scopeKeys,
      states: ["active"],
      includeDetails: true,
      matchAny: true,
      cursor,
      limit: 100,
    });
    records.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && records.length < 500);
  return records;
}

function asRetrievalRecords(records: MemoryRecord[]): RetrievalRecord[] {
  return records;
}

export async function renderAmbientMemoryForPrompt(
  scopes: PromptMemoryScopes,
): Promise<PromptMemoryResult> {
  if (memoryRolloutMode() === "legacy") {
    return { text: "", ids: [], bytes: 0, omitted: 0 };
  }
  const { store } = await ensureMemoryV2Ready();
  store.expireDue();
  const selected = renderAmbientMemory(
    asRetrievalRecords(pinnedRecords(store, scopes.scopeKeys)),
    {
      scopeKeys: scopes.scopeKeys,
      primaryRepoKey: scopes.primaryRepoKey,
    },
  );
  const result = {
    text: selected.text,
    ids: selected.records.map((record) => record.id),
    bytes: selected.bytes,
    omitted: selected.omitted,
  };
  audit({
    kind: "memory_ambient",
    record_ids: result.ids,
    bytes: result.bytes,
    omitted: result.omitted,
  });
  return result;
}

export async function retrieveMemoryForPrompt(
  query: string,
  scopes: PromptMemoryScopes,
): Promise<PromptMemoryResult> {
  if (memoryRolloutMode() === "legacy" || !query.trim()) {
    return { text: "", ids: [], bytes: 0, omitted: 0 };
  }
  const { store } = await ensureMemoryV2Ready();
  store.expireDue();
  const selected = retrieveMemory(
    asRetrievalRecords(matchingRecords(store, scopes.scopeKeys, query)).map(
      (record) => ({
        ...record,
        summary: neutralizeContextSentinels(record.summary),
      }),
    ),
    query,
    {
      scopeKeys: scopes.scopeKeys,
      primaryRepoKey: scopes.primaryRepoKey,
      budgetBytes: Math.max(
        0,
        RETRIEVED_MEMORY_BUDGET_BYTES -
          Buffer.byteLength(wrapContext("", "memory"), "utf8"),
      ),
    },
  );
  const ids = selected.records.map(({ record }) => record.id);
  store.markRetrieved(ids);
  const text = selected.text ? wrapContext(selected.text, "memory") : "";
  audit({
    kind: "memory_retrieval",
    record_ids: ids,
    bytes: Buffer.byteLength(text, "utf8"),
    omitted: selected.omitted,
    query_terms: selected.queryTerms.length,
  });
  return {
    text,
    ids,
    bytes: Buffer.byteLength(text, "utf8"),
    omitted: selected.omitted,
  };
}
