import { expect, test } from "bun:test";
import { apiResourceSWRConfig } from "../lib/api-swr";

test("keeps SWR's default comparator when an API resource has no custom compare", () => {
  const config = apiResourceSWRConfig(5_000);
  expect("compare" in config).toBe(false);
  expect(config.refreshInterval).toBe(5_000);
});

test("passes an explicit API-resource comparator through", () => {
  const compare = (previous?: string, next?: string) => previous === next;
  const config = apiResourceSWRConfig(0, compare);
  expect(config.compare).toBe(compare);
});
