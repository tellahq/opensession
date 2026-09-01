/**
 * Per-CODEX_HOME serialization for operations that may cause Codex to refresh
 * its rotating OAuth token family. The app-server usage read and our idle-token
 * maintenance both begin as reads, but either can refresh an expiring access
 * token and write auth.json. Running them together can spend the same refresh
 * token twice and invalidate the account.
 */

const authTails: Map<string, Promise<void>> = ((
  globalThis as any
).__codexAuthOperationTails ??= new Map());

export async function withCodexAuthLock<T>(
  codexHome: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = authTails.get(codexHome) || Promise.resolve();
  const run = previous.catch(() => {}).then(action);
  const tail = run.then(
    () => {},
    () => {},
  );
  authTails.set(codexHome, tail);
  try {
    return await run;
  } finally {
    if (authTails.get(codexHome) === tail) authTails.delete(codexHome);
  }
}
