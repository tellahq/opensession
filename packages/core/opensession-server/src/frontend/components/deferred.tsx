import React from "react";

/*
 * A pane that loads when first rendered instead of at boot. The bundler
 * turns the import() into its own chunk, so the code for a view nobody has
 * opened yet (onboarding, automations, analytics, reviews...) stays off the
 * critical path of the first paint, which matters most on the phone. The
 * chunk is content-hashed and cached by the service worker after its first
 * fetch, so later opens cost nothing. The fallback is empty: on a warm cache
 * the wait is a few milliseconds, and a spinner that flashes for that long
 * reads as a glitch.
 */
export function deferred<P extends object>(
  load: () => Promise<React.ComponentType<P>>,
): React.ComponentType<P> {
  const Lazy = React.lazy(async () => ({ default: await load() }));
  return function Deferred(props: P) {
    return (
      <React.Suspense fallback={null}>
        <Lazy {...props} />
      </React.Suspense>
    );
  };
}

/** The keys of a module whose exports are components. */
type ComponentKeys<M> = {
  [K in keyof M]: M[K] extends React.ComponentType<never> ? K : never;
}[keyof M];

/*
 * deferred() for one named export of a module, typed as that export: call
 * sites check their props against the real component, and siblings loaded
 * from the same module (the route panes, the diff renderers) share a chunk.
 */
export function deferredExport<M extends object, K extends ComponentKeys<M>>(
  load: () => Promise<M>,
  name: K,
): M[K] {
  // SAFETY: ComponentKeys<M> admits only keys whose export is a component,
  // and a component accepts `never` as its props; the loader forwards
  // whatever props the caller passed.
  const Lazy = deferred<never>(() =>
    load().then((m) => m[name] as React.ComponentType<never>),
  );
  // SAFETY: Deferred renders m[name] with the props it receives unchanged, so
  // it takes exactly the props of M[K].
  return Lazy as M[K];
}
