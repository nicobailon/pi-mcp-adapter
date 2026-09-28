import { Type } from "typebox";

// OMP remaps `typebox` to a host shim that historically lacked Type.Unsafe.
// Prefer Unsafe when present (real TypeBox / fixed OMP shim); otherwise pass
// the normalized JSON Schema through as a plain object so toolWireSchema and
// validateToolArguments still treat it as JSON Schema.
export function toToolParameters(schema: Record<string, unknown>): unknown {
  return typeof (Type as { Unsafe?: (value: never) => unknown }).Unsafe === "function"
    ? (Type as { Unsafe: (value: never) => unknown }).Unsafe(schema as never)
    : schema;
}
