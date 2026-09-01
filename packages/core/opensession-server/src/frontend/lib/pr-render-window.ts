export const INITIAL_PR_ROWS = 60;
export const PR_ROWS_PAGE = 60;

export interface PrRenderWindow {
  scope: string;
  limit: number;
}

export function visiblePrRowLimit(
  window: PrRenderWindow,
  scope: string,
): number {
  return window.scope === scope ? window.limit : INITIAL_PR_ROWS;
}

export function expandPrRenderWindow(
  scope: string,
  limit: number,
): PrRenderWindow {
  return { scope, limit: limit + PR_ROWS_PAGE };
}
