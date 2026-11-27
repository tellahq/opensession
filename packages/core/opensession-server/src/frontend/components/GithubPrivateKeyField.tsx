import { useEffect, useRef, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { IconArrowUpToLine } from "./icons";

export function GithubPrivateKeyField({
  configured,
  required = true,
  saving,
  value,
  onChange,
  description,
}: {
  configured: boolean;
  required?: boolean;
  saving: boolean;
  value: string;
  onChange: (value: string) => void;
  description?: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!value) setFileName(null);
  }, [value]);

  async function selectFile(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    setError(null);
    // Let choosing the same file again fire another change event.
    input.value = "";
    try {
      onChange(await file.text());
      setFileName(file.name);
    } catch {
      setError(
        "Could not read that file. Choose the downloaded PEM file again.",
      );
    }
  }

  const selected = Boolean(value && fileName);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-label font-medium text-dim">
          Private key (PEM)
        </span>
        {selected ? (
          <span className="shrink-0 text-meta text-green">Selected</span>
        ) : configured ? (
          <span className="shrink-0 text-meta text-green">Saved</span>
        ) : required ? (
          <Badge tone="warning">Required</Badge>
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".pem,application/x-pem-file,text/plain"
        className="hidden"
        disabled={saving}
        onChange={(event) => void selectFile(event)}
      />
      <div className="mt-0.5 flex items-center gap-3 phone:flex-col phone:items-stretch">
        <Button
          type="button"
          icon={<IconArrowUpToLine size={20} />}
          disabled={saving}
          className="shrink-0 phone:justify-center"
          onClick={() => inputRef.current?.click()}
        >
          {selected
            ? "Choose another PEM"
            : configured
              ? "Replace PEM file"
              : "Choose PEM file"}
        </Button>
        {fileName && (
          <span
            className="min-w-0 truncate text-supporting text-dim"
            title={fileName}
          >
            {fileName}
          </span>
        )}
      </div>
      <span className="text-meta leading-snug text-faint">
        {description ??
          (configured
            ? "Choose a .pem file to replace the saved private key, or leave it unchanged."
            : "Choose the .pem private key downloaded from GitHub.")}
      </span>
      {error && (
        <span className="text-meta leading-snug text-red" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
