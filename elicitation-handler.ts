import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ElicitRequestSchema,
  ErrorCode,
  McpError,
  type ElicitRequest,
  type ElicitRequestFormParams,
  type ElicitRequestURLParams,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import open from "open";

export type ElicitationValue = string | number | boolean | string[] | undefined;
type FormProperty = ElicitRequestFormParams["requestedSchema"]["properties"][string];

export type ElicitationUIContext = ExtensionUIContext;

export interface ElicitationHandlerOptions {
  serverName: string;
  ui: ElicitationUIContext;
  allowUrl: boolean;
  onUrlAccepted?: (elicitationId: string) => void;
}

export type ServerElicitationConfig = Omit<ElicitationHandlerOptions, "serverName" | "onUrlAccepted">;

export function registerElicitationHandler(client: Client, options: ElicitationHandlerOptions): void {
  client.setRequestHandler(ElicitRequestSchema, (request) =>
    handleElicitationRequest(options, request));
}

export async function handleElicitationRequest(
  options: ElicitationHandlerOptions,
  request: ElicitRequest,
): Promise<ElicitResult> {
  return request.params.mode === "url"
    ? handleUrlElicitation(options, request.params)
    : handleFormElicitation(options, request.params);
}

export async function handleFormElicitation(
  options: ElicitationHandlerOptions,
  params: ElicitRequestFormParams,
): Promise<ElicitResult> {
  const decision = await options.ui.select(
    `MCP Input Request\nServer: ${options.serverName}\n\n${params.message}`,
    ["Continue", "Decline"],
  );
  if (decision === undefined) return { action: "cancel" };
  if (decision === "Decline") return { action: "decline" };

  const values: Record<string, ElicitationValue> = {};
  const properties = Object.entries(params.requestedSchema.properties);
  for (const [name, schema] of properties) {
    const value = await collectValidField(options.ui, params, name, schema);
    if (!("value" in value)) return { action: "cancel" };
    values[name] = value.value;
  }

  while (true) {
    const content = coerceAndValidateFormValues(params, values);
    const action = await options.ui.select(
      formatReview(options.serverName, properties, content),
      properties.length > 0 ? ["Submit", "Edit", "Decline"] : ["Submit", "Decline"],
    );
    if (action === undefined) return { action: "cancel" };
    if (action === "Decline") return { action: "decline" };
    if (action === "Submit") return { action: "accept", content };

    const labels = properties.map(([name, schema]) => `${schema.title ?? humanizeName(name)} (${name})`);
    const selected = await options.ui.select("Choose a field to edit", labels);
    if (selected === undefined) return { action: "cancel" };
    const property = properties[labels.indexOf(selected)];
    if (!property) continue;
    const [name, schema] = property;
    const value = await collectValidField(options.ui, params, name, schema, values[name]);
    if (!("value" in value)) return { action: "cancel" };
    values[name] = value.value;
  }
}

async function collectValidField(
  ui: ElicitationUIContext,
  params: ElicitRequestFormParams,
  name: string,
  schema: FormProperty,
  current?: ElicitationValue,
): Promise<{ cancelled: true } | { cancelled: false; value: ElicitationValue }> {
  const required = params.requestedSchema.required?.includes(name) === true;
  while (true) {
    const result = await collectField(ui, params, name, schema, current);
    if (!("value" in result)) return result;
    try {
      coerceAndValidateFormValues({
        ...params,
        requestedSchema: {
          type: "object",
          properties: { [name]: schema },
          ...(required ? { required: [name] } : {}),
        },
      }, { [name]: result.value });
      return result;
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), "error");
      current = result.value;
    }
  }
}

async function collectField(
  ui: ElicitationUIContext,
  params: ElicitRequestFormParams,
  name: string,
  schema: FormProperty,
  current?: ElicitationValue,
): Promise<{ cancelled: true } | { cancelled: false; value: ElicitationValue }> {
  const required = params.requestedSchema.required?.includes(name) === true;
  const title = [schema.title ?? humanizeName(name), required ? "(required)" : "", schema.description]
    .filter(Boolean)
    .join(" ");

  if (schema.type === "string" && ("enum" in schema || "oneOf" in schema)) {
    const choices = "oneOf" in schema
      ? schema.oneOf.map(option => ({ value: option.const, display: formatChoice(option.const, option.title) }))
      : schema.enum.map((value, index) => ({
          value,
          display: formatChoice(value, "enumNames" in schema ? schema.enumNames?.[index] : undefined),
        }));
    const displays = uniqueLabels(choices.map(choice => choice.display));
    const actions = [...displays];
    const useDefault = schema.default === undefined ? undefined : uniqueAction("Use default", actions);
    if (useDefault) actions.push(useDefault);
    const omit = required ? undefined : uniqueAction("Omit", actions);
    if (omit) actions.push(omit);
    const action = await ui.select(title, actions);
    if (action === undefined) return { cancelled: true };
    if (action === useDefault) return { cancelled: false, value: schema.default };
    if (action === omit) return { cancelled: false, value: undefined };
    return { cancelled: false, value: choices[displays.indexOf(action)]?.value };
  }

  if (schema.type === "boolean") {
    const actions = ["Yes", "No"];
    if (schema.default !== undefined) actions.push("Use default");
    if (!required) actions.push("Omit");
    const action = await ui.select(title, actions);
    if (action === undefined) return { cancelled: true };
    if (action === "Use default") return { cancelled: false, value: schema.default };
    if (action === "Omit") return { cancelled: false, value: undefined };
    return { cancelled: false, value: action === "Yes" };
  }

  if (schema.type === "array") {
    const actions = ["Choose values"];
    if (schema.default !== undefined) actions.push("Use default");
    if (!required) actions.push("Omit");
    const action = await ui.select(title, actions);
    if (action === undefined) return { cancelled: true };
    if (action === "Use default") return { cancelled: false, value: schema.default };
    if (action === "Omit") return { cancelled: false, value: undefined };

    const choices = extractMultiSelectOptions(schema);
    const selected = new Set(Array.isArray(current) ? current : []);
    while (true) {
      const displays = uniqueLabels(choices.map(choice => selected.has(choice.value) ? `✓ ${choice.display}` : choice.display));
      const done = uniqueAction("Done", displays);
      const picked = await ui.select(title, [...displays, done]);
      if (picked === undefined) return { cancelled: true };
      if (picked === done) return { cancelled: false, value: [...selected] };
      const choice = choices[displays.indexOf(picked)];
      if (!choice) continue;
      if (selected.has(choice.value)) selected.delete(choice.value);
      else selected.add(choice.value);
    }
  }

  const actions = ["Enter value"];
  if (schema.default !== undefined) actions.push("Use default");
  if (!required) actions.push("Omit");
  const action = await ui.select(title, actions);
  if (action === undefined) return { cancelled: true };
  if (action === "Use default") return { cancelled: false, value: schema.default };
  if (action === "Omit") return { cancelled: false, value: undefined };
  const entered = await ui.input(title, current === undefined ? undefined : String(current));
  return entered === undefined ? { cancelled: true } : { cancelled: false, value: entered };
}

export function coerceAndValidateFormValues(
  params: ElicitRequestFormParams,
  values: Record<string, ElicitationValue>,
): Record<string, string | number | boolean | string[]> {
  const output: Record<string, string | number | boolean | string[]> = {};
  const required = new Set(params.requestedSchema.required ?? []);
  for (const [name, schema] of Object.entries(params.requestedSchema.properties)) {
    const value = values[name];
    if (value === undefined) {
      if (required.has(name)) throw new Error(`Missing required elicitation field: ${name}`);
      continue;
    }
    if (schema.type === "string") {
      const stringValue = String(value);
      const limits = schema as typeof schema & { minLength?: number; maxLength?: number };
      if (limits.minLength !== undefined && stringValue.length < limits.minLength) {
        throw new Error(`Elicitation field ${name} is shorter than minimum length ${limits.minLength}`);
      }
      if (limits.maxLength !== undefined && stringValue.length > limits.maxLength) {
        throw new Error(`Elicitation field ${name} is longer than maximum length ${limits.maxLength}`);
      }
      if ("enum" in schema && !schema.enum.includes(stringValue)) {
        throw new Error(`Elicitation field ${name} is not an allowed value`);
      }
      if ("oneOf" in schema && !schema.oneOf.some(option => option.const === stringValue)) {
        throw new Error(`Elicitation field ${name} is not an allowed value`);
      }
      output[name] = stringValue;
      continue;
    }
    if (schema.type === "number" || schema.type === "integer") {
      if (typeof value === "string" && value.trim() === "") {
        throw new Error(`Elicitation field ${name} must be a number`);
      }
      const numberValue = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(numberValue)) throw new Error(`Elicitation field ${name} must be a number`);
      if (schema.type === "integer" && !Number.isInteger(numberValue)) {
        throw new Error(`Elicitation field ${name} must be an integer`);
      }
      if (schema.minimum !== undefined && numberValue < schema.minimum) {
        throw new Error(`Elicitation field ${name} is below minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && numberValue > schema.maximum) {
        throw new Error(`Elicitation field ${name} is above maximum ${schema.maximum}`);
      }
      output[name] = numberValue;
      continue;
    }
    if (schema.type === "boolean") {
      output[name] = typeof value === "boolean" ? value : value === "true";
      continue;
    }
    if (schema.type === "array") {
      if (!Array.isArray(value)) throw new Error(`Elicitation field ${name} must be a list`);
      const allowed = new Set(extractMultiSelectOptions(schema).map(option => option.value));
      const arrayValue = value.map(String);
      if (schema.minItems !== undefined && arrayValue.length < schema.minItems) {
        throw new Error(`Elicitation field ${name} has fewer than ${schema.minItems} selections`);
      }
      if (schema.maxItems !== undefined && arrayValue.length > schema.maxItems) {
        throw new Error(`Elicitation field ${name} has more than ${schema.maxItems} selections`);
      }
      if (arrayValue.some(item => !allowed.has(item))) {
        throw new Error(`Elicitation field ${name} contains an invalid selection`);
      }
      output[name] = arrayValue;
    }
  }
  const validation = new AjvJsonSchemaValidator()
    .getValidator(params.requestedSchema as JsonSchemaType)(output);
  if (!validation.valid) {
    throw new Error(`Invalid elicitation response: ${validation.errorMessage}`);
  }
  return output;
}

function formatChoice(value: string, title?: string): string {
  return title && title !== value ? `${title} (${value})` : value;
}

function uniqueLabels(labels: string[]): string[] {
  const used = new Set<string>();
  return labels.map(label => {
    let unique = label;
    while (used.has(unique)) unique += "…";
    used.add(unique);
    return unique;
  });
}

function uniqueAction(label: string, choices: string[]): string {
  let unique = label;
  while (choices.includes(unique)) unique += "…";
  return unique;
}

function extractMultiSelectOptions(schema: Extract<FormProperty, { type: "array" }>): Array<{ value: string; display: string }> {
  const items = schema.items as { enum?: string[]; anyOf?: Array<{ const: string; title: string }> };
  return items.anyOf
    ? items.anyOf.map(option => ({ value: option.const, display: formatChoice(option.const, option.title) }))
    : (items.enum ?? []).map(value => ({ value, display: value }));
}

function formatReview(
  serverName: string,
  properties: Array<[string, FormProperty]>,
  content: Record<string, string | number | boolean | string[]>,
): string {
  const rows = properties.map(([name, schema]) =>
    `${schema.title ?? humanizeName(name)}: ${content[name] === undefined ? "(omitted)" : String(content[name])}`);
  return [`Review input for ${serverName}`, "", ...rows].join("\n");
}

export async function handleUrlElicitation(
  options: ElicitationHandlerOptions,
  params: ElicitRequestURLParams,
): Promise<ElicitResult> {
  if (!options.allowUrl) throw new McpError(ErrorCode.InvalidParams, "URL elicitation is not supported");

  let parsed: URL;
  try {
    parsed = new URL(params.url);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, "URL elicitation supplied an invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new McpError(ErrorCode.InvalidParams, "URL elicitation only supports HTTP and HTTPS URLs");
  }

  const decision = await options.ui.select([
    "MCP Browser Request",
    `Server: ${options.serverName}`,
    "",
    params.message,
    "",
    `Host: ${parsed.host}`,
    `Full URL: ${params.url}`,
    "",
    "Open this URL in your browser?",
  ].join("\n"), ["Open", "Decline"]);
  if (decision === undefined) return { action: "cancel" };
  if (decision === "Decline") return { action: "decline" };

  try {
    await open(params.url);
  } catch (error) {
    options.ui.notify(`Could not open MCP elicitation URL: ${error instanceof Error ? error.message : String(error)}`, "error");
    return { action: "cancel" };
  }
  options.onUrlAccepted?.(params.elicitationId);
  options.ui.notify("Opened browser for MCP elicitation.", "info");
  return { action: "accept" };
}

function humanizeName(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, char => char.toUpperCase());
}
