import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Resolve a candidate only when its real path stays within the real root. */
export function resolveRealContainedPath(root: string, candidate: string, allowMissing = false): string | null {
  const contained = resolveContainedPath(root, candidate);
  if (!contained) return null;
  const canonical = (path: string): string => {
    let existing = path;
    while (allowMissing && !existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) throw new Error("No existing path ancestor");
      existing = parent;
    }
    return resolve(realpathSync(existing), relative(existing, path));
  };
  try {
    const realRoot = canonical(root);
    const realCandidate = canonical(contained);
    return resolveContainedPath(realRoot, realCandidate);
  } catch {
    return null;
  }
}

export function resolveContainedPath(root: string, candidate: string): string | null {
  const resolved = resolve(root, candidate);
  const rel = relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !isAbsolute(rel)) ? resolved : null;
}
