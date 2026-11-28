/**
 * The system file picker, without a hidden file input in the component: a
 * transient one is attached, clicked and removed. Resolves with the chosen
 * files, or none when the picker is dismissed.
 */
export function pickFiles(opts: { multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = opts.multiple ?? true;
    input.hidden = true;
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => done(Array.from(input.files || [])));
    input.addEventListener("cancel", () => done([]));
    document.body.append(input);
    input.click();
  });
}
