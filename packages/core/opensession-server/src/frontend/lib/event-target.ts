export function eventTargetElement(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
}

export function closestHTMLElement(
  event: Event,
  selector: string,
): HTMLElement | null {
  const closest = eventTargetElement(event)?.closest(selector);
  return closest instanceof HTMLElement ? closest : null;
}
