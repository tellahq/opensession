/**
 * Prebuilt simulator viewer embedded into the compiled single-executable build.
 *
 * A `bun build --compile` binary carries no `src/frontend/simulator` tree and
 * no Tailwind CLI, so the viewer that a simulator Portal serves has to travel
 * INSIDE the executable, exactly like the SPA in server/embedded-frontend.ts.
 * scripts/build-compile.ts overwrites this file with generated
 * `import … with { type: "file" }` statements, one per built viewer asset, so
 * Bun embeds their bytes and this manifest maps each served path to its
 * in-binary file path (see Bun.embeddedFiles), then restores this stub.
 *
 * The source install (and `bun run opensession.ts`, the tarball, the test
 * suite) keeps this stub: EMBEDDED_SIMULATOR_VIEWER is null and assets.ts
 * bundles the viewer from source when the Portal starts.
 */

export interface EmbeddedSimulatorViewer {
  /** Served path (e.g. "/main.js" or "/utilities.css") → in-binary file path. */
  assets: Record<string, string>;
}

export const EMBEDDED_SIMULATOR_VIEWER: EmbeddedSimulatorViewer | null = null;
