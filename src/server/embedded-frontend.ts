/**
 * Prebuilt frontend embedded into the compiled single-executable build.
 *
 * A `bun build --compile` binary has no `.frontend-dist/` checkout beside it, so
 * the built SPA (index.html + the hashed JS/CSS/wasm) has to travel INSIDE the
 * executable. scripts/build-compile.ts overwrites this file with generated
 * `import … with { type: "file" }` statements — one per built asset — so Bun
 * embeds their bytes and this manifest maps each served name to its in-binary
 * path (see Bun.embeddedFiles), then restores this stub afterwards.
 *
 * The source build (and `bun run opensession.ts`, the tarball, the install
 * flow, the test suite) keeps this stub: EMBEDDED_FRONTEND is null, and
 * frontend-build.ts falls back to building/serving `.frontend-dist` from disk.
 */

export interface EmbeddedFrontend {
	/** Cache-busting bundle version, mirrors FrontendBundle.version. */
	version: string;
	/** In-binary path of the stitched prod index.html (Bun.file-openable). */
	indexHtmlPath: string;
	/** Served asset name (e.g. "App-abc123.js") → in-binary file path. */
	assets: Record<string, string>;
}

export const EMBEDDED_FRONTEND: EmbeddedFrontend | null = null;
