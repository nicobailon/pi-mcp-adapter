export const EXTRACTION_MODELS = ["cloudflare-workers-ai/clairic", "cloudflare-ai-gateway/clairic"] as const;
export type ExtractionModelId = typeof EXTRACTION_MODELS[number];

export type ResolvedExtractionSettings =
  | { enabled: false }
  | { enabled: true; allowedServers: string[]; model?: ExtractionModelId };

const ACCEPTED_KEYS = new Set(["allowedServers", "model"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function validateExtractionSettings(value: unknown): ResolvedExtractionSettings {
  if (value === undefined || value === false) return { enabled: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings.extraction must be an object or false");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("settings.extraction must be a plain object");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!ACCEPTED_KEYS.has(key)) throw new Error(`settings.extraction.${key} is not supported`);
  const { allowedServers, model } = input;
  if (!Array.isArray(allowedServers) || allowedServers.length === 0) {
    throw new Error("settings.extraction.allowedServers must name at least one server");
  }
  if (allowedServers.some(name => typeof name !== "string" || name.length === 0 || DANGEROUS_KEYS.has(name) || CONTROL_CHARACTERS.test(name))) {
    throw new Error("settings.extraction.allowedServers must contain non-empty safe server names");
  }
  if (model !== undefined && !EXTRACTION_MODELS.includes(model as ExtractionModelId)) {
    throw new Error('settings.extraction.model must be "cloudflare-workers-ai/clairic" or "cloudflare-ai-gateway/clairic"');
  }
  return {
    enabled: true,
    allowedServers: [...new Set(allowedServers as string[])],
    ...(model !== undefined ? { model: model as ExtractionModelId } : {}),
  };
}

/** Settings that reached the config were validated on load; programmatic configs are validated here. */
export function extractionServers(settings: { extraction?: unknown } | undefined): string[] {
  try {
    const resolved = validateExtractionSettings(settings?.extraction);
    return resolved.enabled ? resolved.allowedServers : [];
  } catch {
    return [];
  }
}

export function isExtractionConfigured(settings: { extraction?: unknown } | undefined): boolean {
  return extractionServers(settings).length > 0;
}
