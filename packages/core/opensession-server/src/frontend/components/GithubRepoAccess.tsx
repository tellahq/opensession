import { Button } from "../ui/button";
import { IconArrowUpRight } from "./icons";

export function GithubRepoAccess({
  installations,
  installUrl,
  refreshing,
  onRefresh,
}: {
  installations?: { login: string; type?: string }[];
  installUrl?: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <section aria-label="GitHub repository access" className="mt-3 space-y-2">
      <div className="text-supporting text-dim">
        <span className="font-medium text-fg">Installed on</span>
        {installations === undefined ? (
          <span>: Couldn’t check installed accounts.</span>
        ) : installations.length === 0 ? (
          <span>: No accounts yet.</span>
        ) : (
          <ul className="m-0 mt-1 list-none space-y-1 p-0">
            {installations.map(({ login, type }) => (
              <li key={login} className="flex flex-wrap items-baseline gap-x-2">
                <span className="break-all text-fg">{login}</span>
                {type === "Organization" ? (
                  <span className="text-meta text-faint">Organization</span>
                ) : type === "User" ? (
                  <span className="text-meta text-faint">Personal account</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="m-0 text-supporting leading-snug text-dim">
        Missing repos? Grant the App access to more repositories. A private App
        installs only on the account that owns it, so to reach another account,
        add it under Settings, Integrations, GitHub.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {installUrl && (
          <Button
            size="sm"
            className="phone:min-h-11"
            icon={<IconArrowUpRight size={16} />}
            render={<a href={installUrl} target="_blank" rel="noreferrer" />}
          >
            Choose repositories
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="aria-disabled:opacity-40 phone:min-h-11"
          aria-disabled={refreshing}
          aria-busy={refreshing}
          onClick={() => {
            if (!refreshing) onRefresh();
          }}
        >
          {refreshing ? "Refreshing…" : "Refresh repositories"}
        </Button>
      </div>
    </section>
  );
}
