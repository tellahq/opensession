const BASE_CSS = new URL("./base.css", import.meta.url);
const LOCAL_IMPORT_PATTERN = /^@import "\.\/([^"]+)";$/gm;

/** Read base.css as the browser does, with its local modules in import order. */
export async function readBaseCss(): Promise<string> {
  const entrypoint = await Bun.file(BASE_CSS).text();
  const modules = await Promise.all(
    [...entrypoint.matchAll(LOCAL_IMPORT_PATTERN)].map((match) =>
      Bun.file(new URL(match[1], BASE_CSS)).text(),
    ),
  );
  let nextModule = 0;
  return entrypoint.replace(
    /^@import "\.\/([^"]+)";$/gm,
    () => modules[nextModule++] ?? "",
  );
}
