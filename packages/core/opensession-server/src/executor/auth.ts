import { readFileSync } from "fs";

export const EXECUTOR_CREDENTIAL_NAME = "executor-token";
let credential: string | null | undefined;

export function readExecutorCredential(): string | null {
  const explicit = process.env.OPENSESSION_EXECUTOR_TOKEN?.trim();
  if (
    explicit &&
    (process.env.NODE_ENV === "test" || process.env.OPENSESSION_DEV === "1")
  ) {
    return explicit;
  }
  if (credential !== undefined) return credential;
  const credentialsDir = process.env.CREDENTIALS_DIRECTORY;
  if (!credentialsDir) return (credential = null);
  try {
    credential =
      readFileSync(
        `${credentialsDir}/${EXECUTOR_CREDENTIAL_NAME}`,
        "utf8",
      ).trim() || null;
  } catch {
    credential = null;
  }
  return credential;
}
