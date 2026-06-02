import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { formatSchema } from "./tool-metadata.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const TIMEOUT = Symbol("timeout");
const UI_FAILURE = Symbol("ui-failure");

export interface ElicitationHandlerOptions {
  serverName: string;
  ui?: ExtensionUIContext;
  timeoutMs?: number;
}

export type ServerElicitationConfig = Omit<ElicitationHandlerOptions, "serverName">;

interface ElicitationSchema {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
}

interface PropertySchema {
  type?: unknown;
  description?: unknown;
  default?: unknown;
  enum?: unknown;
  enumNames?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
}

interface FieldSpec {
  name: string;
  schema: PropertySchema;
  required: boolean;
  type: "string" | "number" | "integer" | "boolean";
  enumValues?: string[];
  enumNames?: string[];
}

type ElicitationValue = string | number | boolean | string[];
type ElicitationContent = Record<string, ElicitationValue>;

export function registerElicitationHandler(client: Client, options: ElicitationHandlerOptions): void {
  client.setRequestHandler(ElicitRequestSchema, (request) => {
    return handleElicitationRequest(options, request as ElicitRequest);
  });
}

export async function handleElicitationRequest(
  options: ElicitationHandlerOptions,
  request: ElicitRequest,
): Promise<ElicitResult> {
  const params = request.params as ElicitRequest["params"] & {
    mode?: string;
    requestedSchema?: unknown;
  };

  if (params.mode && params.mode !== "form") {
    return { action: "cancel" };
  }
  if (!options.ui) {
    return { action: "cancel" };
  }

  const schema = parseObjectSchema(params.requestedSchema);
  if (!schema) {
    return { action: "cancel" };
  }

  const fields = getFieldSpecs(schema);
  if (!fields) {
    return { action: "cancel" };
  }

  const approved = await callTrustedUi(
    options,
    () => options.ui!.confirm(
      `MCP request from ${options.serverName}`,
      formatInitialApproval(options.serverName, params.message, schema),
      dialogOptions(options),
    ),
  );
  if (approved === TIMEOUT || approved === UI_FAILURE) return { action: "cancel" };
  if (approved === undefined) return { action: "cancel" };
  if (!approved) return { action: "decline" };

  const content: ElicitationContent = {};
  for (const field of fields) {
    const value = await collectFieldValue(options, field);
    if (value === TIMEOUT || value === UI_FAILURE) return { action: "cancel" };
    if (value === undefined) {
      if (field.required) return { action: "cancel" };
      continue;
    }
    content[field.name] = value;
  }

  if (!validateContent(fields, content)) {
    return { action: "cancel" };
  }

  const finalApproval = await callTrustedUi(
    options,
    () => options.ui!.confirm(
      `Return MCP response to ${options.serverName}`,
      `The MCP server will receive:\n\n${JSON.stringify(content, null, 2)}`,
      dialogOptions(options),
    ),
  );
  if (finalApproval === TIMEOUT || finalApproval === UI_FAILURE) return { action: "cancel" };
  if (finalApproval === undefined) return { action: "cancel" };
  if (!finalApproval) return { action: "decline" };

  return { action: "accept", content };
}

function parseObjectSchema(schema: unknown): ElicitationSchema | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const objectSchema = schema as ElicitationSchema;
  if (objectSchema.type !== "object") return null;
  if (
    objectSchema.properties !== undefined
    && (typeof objectSchema.properties !== "object" || objectSchema.properties === null || Array.isArray(objectSchema.properties))
  ) {
    return null;
  }
  if (objectSchema.required !== undefined && !Array.isArray(objectSchema.required)) {
    return null;
  }
  return objectSchema;
}

function getFieldSpecs(schema: ElicitationSchema): FieldSpec[] | null {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : [];
  const fields: FieldSpec[] = [];

  for (const [name, rawProperty] of Object.entries(properties)) {
    const property = parsePropertySchema(rawProperty);
    const isRequired = required.includes(name);
    if (!property) {
      if (isRequired) return null;
      continue;
    }
    fields.push({ name, required: isRequired, ...property });
  }

  for (const requiredName of required) {
    if (!Object.prototype.hasOwnProperty.call(properties, requiredName)) {
      return null;
    }
  }

  return fields;
}

function parsePropertySchema(schema: unknown): Omit<FieldSpec, "name" | "required"> | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const property = schema as PropertySchema;
  const enumValues = Array.isArray(property.enum)
    ? property.enum.filter((value): value is string => typeof value === "string")
    : undefined;
  const enumNames = Array.isArray(property.enumNames)
    ? property.enumNames.filter((value): value is string => typeof value === "string")
    : undefined;

  if (enumValues && enumValues.length > 0) {
    if (property.type !== undefined && property.type !== "string") return null;
    return {
      schema: property,
      type: "string",
      enumValues,
      enumNames: enumNames && enumNames.length === enumValues.length ? enumNames : undefined,
    };
  }

  if (property.type === "string" || property.type === "number" || property.type === "integer" || property.type === "boolean") {
    return { schema: property, type: property.type };
  }

  return null;
}

async function collectFieldValue(options: ElicitationHandlerOptions, field: FieldSpec): Promise<ElicitationValue | undefined | typeof TIMEOUT | typeof UI_FAILURE> {
  if (field.enumValues) {
    return collectEnumValue(options, field);
  }
  if (field.type === "boolean") {
    return collectBooleanValue(options, field);
  }
  return collectInputValue(options, field);
}

async function collectEnumValue(options: ElicitationHandlerOptions, field: FieldSpec): Promise<string | undefined | typeof TIMEOUT | typeof UI_FAILURE> {
  const choices = field.enumNames ?? field.enumValues!;
  const selected = await callTrustedUi(
    options,
    () => (options.ui! as any).select(
      fieldTitle(field),
      choices,
      dialogOptions(options),
    ),
  );
  if (selected === TIMEOUT) return TIMEOUT;
  if (selected === UI_FAILURE) return UI_FAILURE;
  if (typeof selected !== "string") return undefined;
  const index = choices.indexOf(selected);
  return index >= 0 ? field.enumValues![index] : undefined;
}

async function collectBooleanValue(options: ElicitationHandlerOptions, field: FieldSpec): Promise<boolean | undefined | typeof TIMEOUT | typeof UI_FAILURE> {
  const selected = await callTrustedUi(
    options,
    () => (options.ui! as any).select(
      fieldTitle(field),
      ["true", "false"],
      dialogOptions(options),
    ),
  );
  if (selected === TIMEOUT) return TIMEOUT;
  if (selected === UI_FAILURE) return UI_FAILURE;
  if (selected === "true") return true;
  if (selected === "false") return false;
  return undefined;
}

async function collectInputValue(options: ElicitationHandlerOptions, field: FieldSpec): Promise<ElicitationValue | undefined | typeof TIMEOUT | typeof UI_FAILURE> {
  const answer = await callTrustedUi(
    options,
    () => (options.ui! as any).input(
      fieldTitle(field),
      inputPlaceholder(field),
      dialogOptions(options),
    ),
  );
  if (answer === TIMEOUT) return TIMEOUT;
  if (answer === UI_FAILURE) return UI_FAILURE;
  if (typeof answer !== "string") return undefined;
  if (answer === "" && field.schema.default !== undefined) return defaultValue(field);
  if (field.type === "string") return answer;

  const parsed = Number(answer);
  if (!Number.isFinite(parsed)) return undefined;
  if (field.type === "integer" && !Number.isInteger(parsed)) return undefined;
  return parsed;
}

async function callTrustedUi<T>(
  options: ElicitationHandlerOptions,
  fn: () => Promise<T>,
): Promise<T | typeof TIMEOUT | typeof UI_FAILURE> {
  const timeoutMs = timeoutMsForOptions(options);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<typeof TIMEOUT>((resolve) => {
        timeout = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      }),
    ]);
  } catch {
    return UI_FAILURE;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function validateContent(fields: FieldSpec[], content: ElicitationContent): boolean {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(content, field.name)) {
      if (field.required) return false;
      continue;
    }
    if (!validateFieldValue(field, content[field.name])) {
      return false;
    }
  }
  return true;
}

function validateFieldValue(field: FieldSpec, value: unknown): boolean {
  if (field.enumValues) {
    return typeof value === "string" && field.enumValues.includes(value);
  }
  if (field.type === "boolean") {
    return typeof value === "boolean";
  }
  if (field.type === "string") {
    if (typeof value !== "string") return false;
    if (typeof field.schema.minLength === "number" && value.length < field.schema.minLength) return false;
    if (typeof field.schema.maxLength === "number" && value.length > field.schema.maxLength) return false;
    return true;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (field.type === "integer" && !Number.isInteger(value)) return false;
  if (typeof field.schema.minimum === "number" && value < field.schema.minimum) return false;
  if (typeof field.schema.maximum === "number" && value > field.schema.maximum) return false;
  return true;
}

function defaultValue(field: FieldSpec): ElicitationValue | undefined {
  const value = field.schema.default;
  if (field.type === "string") return typeof value === "string" ? value : undefined;
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (field.type === "integer") return typeof value === "number" && Number.isInteger(value) ? value : undefined;
  if (field.type === "boolean") return typeof value === "boolean" ? value : undefined;
  return undefined;
}

function dialogOptions(options: ElicitationHandlerOptions): { timeout: number } {
  return { timeout: timeoutMsForOptions(options) };
}

function formatInitialApproval(serverName: string, message: string, schema: ElicitationSchema): string {
  return `${serverName} is requesting user input:\n\n${message}\n\nRequested fields:\n${formatSchema(schema)}`;
}

function fieldTitle(field: FieldSpec): string {
  return `${field.name}${field.required ? " (required)" : ""}`;
}

function inputPlaceholder(field: FieldSpec): string {
  if (typeof field.schema.description === "string") {
    return field.schema.description;
  }
  return defaultText(field.schema.default) || "";
}

function defaultText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function timeoutMsForOptions(options: ElicitationHandlerOptions): number {
  return typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
}
