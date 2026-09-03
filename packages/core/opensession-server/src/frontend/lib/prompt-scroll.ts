/** Each hairline earns its place only while content sits beyond that edge:
 * a short prompt that fits gets a clean, undivided card. */
export function promptScrollEdges(el: HTMLDivElement) {
  const hidden = el.scrollHeight - el.clientHeight;
  return {
    top: el.scrollTop > 1,
    bottom: hidden > 1 && hidden - el.scrollTop > 1,
  };
}
