/** .automation-form label */
export const FIELD_LABEL =
  "flex flex-1 flex-col gap-1.5 text-label font-medium text-dim";

/** .automation-form-row */
export const FORM_ROW = "flex gap-3.5 phone:flex-col";

export function sandboxProviderLabel(id: string): string {
  if (id === "docker") return "Docker";
  if (id === "daytona") return "Daytona";
  if (id === "e2b") return "E2B";
  if (id === "box") return "Box";
  if (id === "modal") return "Modal";
  if (id === "lambda-microvm") return "AWS Lambda MicroVM";
  return id;
}

export function uniqueFlowId(prefix: string, used: string[]): string {
  let candidate = prefix;
  let index = 2;
  while (used.includes(candidate)) candidate = `${prefix}-${index++}`;
  return candidate;
}
