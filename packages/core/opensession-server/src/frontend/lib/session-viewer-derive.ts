export function reviewReposFromKey(key: string) {
  return key.split("\u0000").map((repo, index) => ({
    repo,
    primary: index === 0,
  }));
}

export function discoveredPrsFromKey(key: string) {
  if (!key) return [];
  return key.split("\u0001").map((encoded) => {
    const [repo, branch, number, url, title] = encoded.split("\u0000");
    return {
      repo,
      branch,
      number: number ? Number(number) : undefined,
      url: url || undefined,
      title: title || undefined,
    };
  });
}

export function toolPathRootsFromKey(key: string) {
  const [primaryDir = "", ...attached] = key.split("\u0001");
  return [
    { dir: primaryDir },
    ...attached.map((encoded) => {
      const [dir, label] = encoded.split("\u0000");
      return { dir, label };
    }),
  ].filter((root) => Boolean(root.dir));
}
