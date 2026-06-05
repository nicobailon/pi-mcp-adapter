import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitRequestFormParams,
  type ElicitRequestURLParams,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import open from "open";

export type ExtensionUIFormValue = string | number | boolean | string[] | undefined;

export interface ExtensionUIFormSelectOption {
  value: string;
  label?: string;
  description?: string;
}

export type ExtensionUIFormField =
  | {
      type: "text";
      name: string;
      label: string;
      description?: string;
      placeholder?: string;
      required?: boolean;
      defaultValue?: string;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    }
  | {
      type: "number" | "integer";
      name: string;
      label: string;
      description?: string;
      required?: boolean;
      defaultValue?: number;
      minimum?: number;
      maximum?: number;
    }
  | {
      type: "boolean";
      name: string;
      label: string;
      description?: string;
      defaultValue?: boolean;
    }
  | {
      type: "select";
      name: string;
      label: string;
      description?: string;
      required?: boolean;
      options: ExtensionUIFormSelectOption[];
      defaultValue?: string;
    }
  | {
      type: "multiSelect";
      name: string;
      label: string;
      description?: string;
      required?: boolean;
      options: ExtensionUIFormSelectOption[];
      defaultValue?: string[];
    };

export interface ExtensionUIFormRequest {
  title: string;
  message?: string;
  fields: ExtensionUIFormField[];
  submitLabel?: string;
  secondaryLabel?: string;
  cancelLabel?: string;
}

export type ExtensionUIFormResult =
  | { action: "submit"; values: Record<string, ExtensionUIFormValue> }
  | { action: "secondary" }
  | { action: "cancel" };

export interface ElicitationUIContext extends ExtensionUIContext {
  form(request: ExtensionUIFormRequest): Promise<ExtensionUIFormResult>;
}

export interface ElicitationHandlerOptions {
  serverName: string;
  ui: ElicitationUIContext;
  autoOpenUrls: boolean;
}

export type ServerElicitationConfig = Omit<ElicitationHandlerOptions, "serverName">;

export function registerElicitationHandler(client: Client, options: ElicitationHandlerOptions): void {
  client.setRequestHandler(ElicitRequestSchema, (request) => {
    return handleElicitationRequest(options, request as ElicitRequest);
  });
}

export async function handleElicitationRequest(
  options: ElicitationHandlerOptions,
  request: ElicitRequest,
): Promise<ElicitResult> {
  const params = request.params;
  if (params.mode === "url") {
    return handleUrlElicitation(options, params);
  }
  return handleFormElicitation(options, params);
}

export async function handleFormElicitation(
  options: ElicitationHandlerOptions,
  params: ElicitRequestFormParams,
): Promise<ElicitResult> {
  try {
    const form = convertMcpSchemaToPiForm(options.serverName, params);
    const result = await options.ui.form(form);
    if (result.action !== "submit") {
      return convertPiFormResultToMcpResult(result);
    }
    return {
      action: "accept",
      content: coerceAndValidateFormValues(params, result.values),
    };
  } catch {
    return { action: "cancel" };
  }
}

export async function handleUrlElicitation(
  options: ElicitationHandlerOptions,
  params: ElicitRequestURLParams,
): Promise<ElicitResult> {
  let browserUrl: URL;
  try {
    browserUrl = getBrowserElicitationUrl(params.url);
    if (!options.autoOpenUrls) {
      const result = await options.ui.form({
        title: "MCP Browser Request",
        message: [
          `Server: ${options.serverName}`,
          "",
          params.message,
          "",
          `Domain: ${browserUrl.host}`,
          `URL: ${browserUrl.toString()}`,
          "",
          "Open this URL in your browser?",
        ].join("\n"),
        fields: [],
        submitLabel: "Open",
        secondaryLabel: "Decline",
        cancelLabel: "Cancel",
      });
      if (result.action === "secondary") return { action: "decline" };
      if (result.action === "cancel") return { action: "cancel" };
    }

    await open(browserUrl.toString());
  } catch {
    return { action: "cancel" };
  }

  try {
    await Promise.resolve(options.ui.notify("Opened browser for MCP elicitation.", "info"));
  } catch {
    // Notification failure should not overturn a browser launch the user already accepted.
  }
  return { action: "accept" };
}

export function convertMcpSchemaToPiForm(
  serverName: string,
  params: ElicitRequestFormParams,
): ExtensionUIFormRequest {
  const required = new Set(params.requestedSchema.required ?? []);
  return {
    title: "MCP Input Request",
    message: `Server: ${serverName}\n\n${params.message}`,
    submitLabel: "Submit",
    secondaryLabel: "Decline",
    cancelLabel: "Cancel",
    fields: Object.entries(params.requestedSchema.properties).map(([name, schema]): ExtensionUIFormField => {
      const label = schema.title ?? humanizeName(name);
      const base = {
        name,
        label,
        description: schema.description,
        required: required.has(name),
      };

      if (schema.type === "string" && "oneOf" in schema && Array.isArray(schema.oneOf)) {
        return omitUndefined({
          ...base,
          type: "select" as const,
          options: schema.oneOf.map((option) => ({ value: option.const, label: option.title })),
          defaultValue: schema.default,
        });
      }

      if (schema.type === "string" && "enum" in schema && Array.isArray(schema.enum)) {
        const enumNames = "enumNames" in schema && Array.isArray(schema.enumNames) ? schema.enumNames : undefined;
        return omitUndefined({
          ...base,
          type: "select" as const,
          options: schema.enum.map((value, index) => omitUndefined({ value, label: enumNames?.[index] })),
          defaultValue: schema.default,
        });
      }

      if (schema.type === "array") {
        return omitUndefined({
          ...base,
          type: "multiSelect" as const,
          options: extractMultiSelectOptions(schema),
          defaultValue: schema.default,
        });
      }

      if (schema.type === "number" || schema.type === "integer") {
        return omitUndefined({
          ...base,
          type: schema.type,
          defaultValue: schema.default,
          minimum: schema.minimum,
          maximum: schema.maximum,
        });
      }

      if (schema.type === "boolean") {
        return omitUndefined({
          type: "boolean" as const,
          name,
          label,
          description: schema.description,
          defaultValue: schema.default,
        });
      }

      const stringSchema = schema as { default?: string; minLength?: number; maxLength?: number };
      return omitUndefined({
        ...base,
        type: "text" as const,
        defaultValue: stringSchema.default,
        minLength: stringSchema.minLength,
        maxLength: stringSchema.maxLength,
      });
    }),
  };
}

export function convertPiFormResultToMcpResult(result: ExtensionUIFormResult): ElicitResult {
  if (result.action === "secondary") return { action: "decline" };
  if (result.action === "cancel") return { action: "cancel" };
  return { action: "accept", content: stripUndefined(result.values) as ElicitResult["content"] };
}

export function coerceAndValidateFormValues(
  params: ElicitRequestFormParams,
  values: Record<string, ExtensionUIFormValue>,
): Record<string, string | number | boolean | string[]> {
  const output: Record<string, string | number | boolean | string[]> = {};
  const required = new Set(params.requestedSchema.required ?? []);

  for (const [name, schema] of Object.entries(params.requestedSchema.properties)) {
    const raw = values[name] ?? schema.default;
    if (raw === undefined || (raw === "" && schema.type !== "string")) {
      if (required.has(name)) throw new Error(`Missing required elicitation field: ${name}`);
      continue;
    }

    if (schema.type === "string") {
      const stringSchema = schema as { minLength?: number; maxLength?: number };
      const value = String(raw);
      if (stringSchema.minLength !== undefined && value.length < stringSchema.minLength) {
        throw new Error(`Elicitation field ${name} is shorter than minimum length ${stringSchema.minLength}`);
      }
      if (stringSchema.maxLength !== undefined && value.length > stringSchema.maxLength) {
        throw new Error(`Elicitation field ${name} is longer than maximum length ${stringSchema.maxLength}`);
      }
      if ("enum" in schema && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        throw new Error(`Elicitation field ${name} is not an allowed value`);
      }
      if ("oneOf" in schema && Array.isArray(schema.oneOf) && !schema.oneOf.some((option) => option.const === value)) {
        throw new Error(`Elicitation field ${name} is not an allowed value`);
      }
      output[name] = value;
      continue;
    }

    if (schema.type === "number" || schema.type === "integer") {
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value)) throw new Error(`Elicitation field ${name} must be a number`);
      if (schema.type === "integer" && !Number.isInteger(value)) throw new Error(`Elicitation field ${name} must be an integer`);
      if (schema.minimum !== undefined && value < schema.minimum) {
        throw new Error(`Elicitation field ${name} is below minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        throw new Error(`Elicitation field ${name} is above maximum ${schema.maximum}`);
      }
      output[name] = value;
      continue;
    }

    if (schema.type === "boolean") {
      output[name] = typeof raw === "boolean" ? raw : raw === "true";
      continue;
    }

    if (schema.type === "array") {
      if (!Array.isArray(raw)) throw new Error(`Elicitation field ${name} must be a list`);
      const allowed = new Set(extractMultiSelectOptions(schema).map((option) => option.value));
      const value = raw.map(String);
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        throw new Error(`Elicitation field ${name} has fewer than ${schema.minItems} selections`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        throw new Error(`Elicitation field ${name} has more than ${schema.maxItems} selections`);
      }
      for (const item of value) {
        if (!allowed.has(item)) throw new Error(`Elicitation field ${name} contains an invalid selection`);
      }
      output[name] = value;
    }
  }

  return output;
}

function extractMultiSelectOptions(schema: Extract<ElicitRequestFormParams["requestedSchema"]["properties"][string], { type: "array" }>): ExtensionUIFormSelectOption[] {
  const items = schema.items as { enum?: string[]; anyOf?: Array<{ const: string; title: string }> };
  if (Array.isArray(items.anyOf)) {
    return items.anyOf.map((option) => ({ value: option.const, label: option.title }));
  }
  return (items.enum ?? []).map((value) => ({ value }));
}

function humanizeName(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}

function getBrowserElicitationUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`MCP URL elicitation only supports http/https URLs: ${parsed.protocol}`);
  }
  return parsed;
}

function stripUndefined(values: Record<string, ExtensionUIFormValue>): Record<string, string | number | boolean | string[]> {
  const output: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
