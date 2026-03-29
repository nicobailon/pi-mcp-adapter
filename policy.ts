// policy.ts — TYPE STUBS ONLY (no business logic)
// Real implementation will be added by tdd-green.

export type Primitive = string | number | boolean | null;

export interface ToolPolicy {
  forbidKeys?: string[];
  requireKeys?: string[];
  forbidPerItemKeys?: string[];
  requirePerItemKeys?: string[];
  defaults?: Record<string, unknown>;
  injectIntoEachItem?: Record<string, unknown>;
  allowedValues?: Record<string, Primitive[]>;
  allowedValuesEach?: Record<string, Primitive[]>;
}

export interface ServerPolicy {
  allowedTools?: string[];
  allowedResources?: string[];
  allowedPrompts?: string[];
  toolPolicies?: Record<string, ToolPolicy>;
}

export function validateServerPolicy(policy: ServerPolicy): void {
  const errors: string[] = [];
  const { allowedTools, toolPolicies } = policy;
  const hasAllowList = allowedTools && allowedTools.length > 0;

  if (toolPolicies) {
    for (const [toolName, tp] of Object.entries(toolPolicies)) {
      if (hasAllowList && !allowedTools!.includes(toolName)) {
        errors.push(`toolPolicies key "${toolName}" is not in allowedTools`);
      }
      for (const k of tp.forbidKeys ?? []) {
        if (tp.requireKeys?.includes(k)) {
          errors.push(`"${k}" is in both forbidKeys and requireKeys`);
        }
      }
      for (const k of tp.forbidPerItemKeys ?? []) {
        if (tp.requirePerItemKeys?.includes(k)) {
          errors.push(`"${k}" is in both forbidPerItemKeys and requirePerItemKeys`);
        }
      }
      for (const k of Object.keys(tp.defaults ?? {})) {
        if (tp.forbidKeys?.includes(k)) {
          errors.push(`"${k}" is in both defaults and forbidKeys`);
        }
      }
      for (const k of Object.keys(tp.injectIntoEachItem ?? {})) {
        if (tp.forbidPerItemKeys?.includes(k)) {
          errors.push(`"${k}" is in both injectIntoEachItem and forbidPerItemKeys`);
        }
      }
      for (const [key, vals] of Object.entries(tp.allowedValues ?? {})) {
        for (const v of vals) {
          if (v !== null && typeof v === 'object') {
            errors.push(`allowedValues["${key}"] contains a non-primitive value`);
            break;
          }
        }
      }
      for (const [key, vals] of Object.entries(tp.allowedValuesEach ?? {})) {
        for (const v of vals) {
          if (v !== null && typeof v === 'object') {
            errors.push(`allowedValuesEach["${key}"] contains a non-primitive value`);
            break;
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
}

export function isToolAllowed(policy: ServerPolicy, toolName: string): boolean {
  const list = policy.allowedTools;
  return !list || list.length === 0 || list.includes(toolName);
}

export function isResourceAllowed(policy: ServerPolicy, resourceUri: string): boolean {
  const list = policy.allowedResources;
  return !list || list.length === 0 || list.includes(resourceUri);
}

export function isPromptAllowed(policy: ServerPolicy, promptName: string): boolean {
  const list = policy.allowedPrompts;
  return !list || list.length === 0 || list.includes(promptName);
}

export function filterAllowedTools<T extends { name: string }>(policy: ServerPolicy, tools: T[]): T[] {
  const list = policy.allowedTools;
  return (!list || list.length === 0) ? tools : tools.filter(t => list.includes(t.name));
}

export function filterAllowedResources<T extends { uri: string }>(policy: ServerPolicy, resources: T[]): T[] {
  const list = policy.allowedResources;
  return (!list || list.length === 0) ? resources : resources.filter(r => list.includes(r.uri));
}

export function filterAllowedPrompts<T extends { name: string }>(policy: ServerPolicy, prompts: T[]): T[] {
  const list = policy.allowedPrompts;
  return (!list || list.length === 0) ? prompts : prompts.filter(p => list.includes(p.name));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

export function applyToolPolicy(
  policy: ToolPolicy,
  args: unknown
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  // 1. Shape check
  if (!isPlainObject(args)) {
    return { ok: false, error: 'args must be a plain object' };
  }

  // 2. items must be array if present
  if ('items' in args && !Array.isArray(args.items)) {
    return { ok: false, error: 'items must be an array' };
  }

  // 3. each item must be plain object
  const items = args.items as unknown[] | undefined;
  if (items) {
    for (const item of items) {
      if (!isPlainObject(item)) {
        return { ok: false, error: 'each item in items must be a plain object' };
      }
    }
  }

  // 4. Clone args (shallow)
  const result: Record<string, unknown> = { ...args };
  const clonedItems: Record<string, unknown>[] | undefined = items
    ? items.map(item => ({ ...(item as Record<string, unknown>) }))
    : undefined;
  if (clonedItems !== undefined) result.items = clonedItems;

  // 5. Apply defaults
  for (const [k, v] of Object.entries(policy.defaults ?? {})) {
    if (!(k in result)) result[k] = v;
  }

  // 6. Check forbidKeys
  for (const k of policy.forbidKeys ?? []) {
    if (k in result) return { ok: false, error: `key "${k}" is forbidden` };
  }

  // 7. Check requireKeys
  for (const k of policy.requireKeys ?? []) {
    if (!(k in result)) return { ok: false, error: `required key "${k}" is missing` };
  }

  // 8. Check allowedValues
  for (const [k, allowed] of Object.entries(policy.allowedValues ?? {})) {
    if (k in result && !allowed.includes(result[k] as Primitive)) {
      return { ok: false, error: `value for "${k}" is not in allowed list` };
    }
  }

  // 9. injectIntoEachItem
  if (clonedItems) {
    for (const item of clonedItems) {
      for (const [k, v] of Object.entries(policy.injectIntoEachItem ?? {})) {
        if (!(k in item)) item[k] = v;
      }
    }
  }

  // 10. forbidPerItemKeys
  if (clonedItems) {
    for (const item of clonedItems) {
      for (const k of policy.forbidPerItemKeys ?? []) {
        if (k in item) return { ok: false, error: `per-item key "${k}" is forbidden` };
      }
    }
  }

  // 11. requirePerItemKeys
  if (clonedItems) {
    for (const item of clonedItems) {
      for (const k of policy.requirePerItemKeys ?? []) {
        if (!(k in item)) return { ok: false, error: `required per-item key "${k}" is missing` };
      }
    }
  }

  // 12. allowedValuesEach
  if (clonedItems) {
    for (const item of clonedItems) {
      for (const [k, allowed] of Object.entries(policy.allowedValuesEach ?? {})) {
        if (k in item && !allowed.includes(item[k] as Primitive)) {
          return { ok: false, error: `per-item value for "${k}" is not in allowed list` };
        }
      }
    }
  }

  return { ok: true, args: result };
}
