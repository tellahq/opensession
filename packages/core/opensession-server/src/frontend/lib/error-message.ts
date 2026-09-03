export function errorMessage<Rejected>(
  error: Rejected,
  fallback: string,
): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
