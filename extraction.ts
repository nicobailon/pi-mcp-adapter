/** A field as Clairic receives it in the request's `fields` map. */
export interface ClairicFieldSpec {
  type: "text" | "number" | "date" | "time" | "datetime" | "duration" | "list";
  instructions?: string;
  unit?: string;
  integer?: true;
  decimals?: number;
  items?: "text" | "number" | "date";
  null_threshold?: number;
}

/** A requested field: the type the agent wrote and the spec sent for it. */
export interface ExtractField {
  type: string;
  spec: ClairicFieldSpec;
}

export type ParsedExtractFields =
  | { ok: true; fields: Record<string, ExtractField> }
  | { ok: false; message: string };

const MAX_FIELDS = 16;
const NULL_THRESHOLD = 0.5;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const DURATION_UNITS = ["seconds", "minutes", "hours", "days", "weeks", "months", "years"];
const FIELD_TYPES: Record<string, ClairicFieldSpec> = {
  text: { type: "text" },
  number: { type: "number" },
  integer: { type: "number", integer: true },
  date: { type: "date" },
  time: { type: "time" },
  datetime: { type: "datetime" },
  duration: { type: "duration" },
  ...Object.fromEntries(DURATION_UNITS.map((unit) => [`duration.${unit}`, { type: "duration" as const, unit }])),
  list: { type: "list", items: "text" },
  "list.number": { type: "list", items: "number" },
  "list.date": { type: "list", items: "date" },
};
const OBJECT_KEYS = new Set(["type", "description", "unit", "decimals"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseField(name: string, value: unknown): ExtractField | string {
  const label = `field "${name}"`;
  const written = typeof value === "string" ? { type: value } : value;
  if (!isPlainObject(written)) return `${label} must be a type name or an object with a type`;
  const extra = Object.keys(written).find((key) => !OBJECT_KEYS.has(key));
  if (extra !== undefined) return `${label} has an unsupported option (use type, description, unit or decimals)`;
  const { type, description, unit, decimals } = written;
  if (typeof type !== "string" || !Object.hasOwn(FIELD_TYPES, type)) return `${label} has an unknown type`;
  const spec: ClairicFieldSpec = { ...FIELD_TYPES[type]! };
  if (description !== undefined) {
    if (typeof description !== "string" || description.trim().length === 0) return `${label}: description must be a nonblank string`;
    spec.instructions = description;
  }
  if (unit !== undefined) {
    if (spec.type === "duration") {
      if (spec.unit !== undefined) return `${label}: unit is already part of its type`;
      if (typeof unit !== "string" || !DURATION_UNITS.includes(unit)) return `${label}: a duration unit must be one of ${DURATION_UNITS.join(", ")}`;
    } else if (spec.type !== "number") {
      return `${label}: unit applies only to number and duration fields`;
    } else if (typeof unit !== "string" || unit.trim().length === 0) {
      return `${label}: unit must be a nonblank string`;
    }
    spec.unit = unit;
  }
  if (decimals !== undefined) {
    const allowed = type === "number" || spec.type === "duration" || type === "list.number";
    if (!allowed) return `${label}: decimals applies only to number, duration and list.number fields`;
    if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 6) return `${label}: decimals must be an integer from 0 to 6`;
    spec.decimals = decimals as number;
  }
  if (spec.type !== "list") spec.null_threshold = NULL_THRESHOLD;
  return { type, spec };
}

/** Checks what the agent wrote for `extract` and maps it to Clairic field specs. Reasons are adapter-written. */
export function parseExtractFields(value: unknown): ParsedExtractFields {
  if (!isPlainObject(value)) return { ok: false, message: "extract must be an object of field names to types" };
  const names = Object.keys(value);
  if (names.length === 0 || names.length > MAX_FIELDS) return { ok: false, message: `extract needs 1 to ${MAX_FIELDS} fields` };
  const fields: Record<string, ExtractField> = {};
  for (const name of names) {
    if (!FIELD_NAME.test(name) || name === "__proto__") {
      return { ok: false, message: "field names must start with a letter or underscore and use only letters, digits, _, . or - (64 characters at most)" };
    }
    const field = parseField(name, value[name]);
    if (typeof field === "string") return { ok: false, message: field };
    fields[name] = field;
  }
  return { ok: true, fields };
}
