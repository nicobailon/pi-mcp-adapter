export function captureEnv(names: readonly string[]): () => void {
  const original = new Map<string, string | undefined>();

  for (const name of names) {
    original.set(name, process.env[name]);
  }

  return () => {
    for (const [name, value] of original) {
      if (value === undefined) {
        delete process.env[name];
        continue;
      }

      process.env[name] = value;
    }
  };
}
