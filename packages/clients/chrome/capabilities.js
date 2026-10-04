// Missing flags disable optional features; future and malformed values are safe.
export function supportsCapability(descriptor, key) {
  const flag = descriptor?.capabilities?.[key];
  return flag === true || (Number.isSafeInteger(flag) && flag >= 1);
}
