import { Ajv, type ErrorObject } from "ajv";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator as JsonSchemaValidatorProvider,
} from "@modelcontextprotocol/client";

// ajv-formats types target its bundled ajv; the runtime accepts both instances.
const addFormats = addFormatsImport as unknown as (instance: Ajv) => void;

type SchemaDialect =
  | { status: "unstamped" }
  | { status: "stamped"; uri: string };

const DRAFT_07_SCHEMA_URIS: ReadonlySet<string> = new Set([
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema",
]);
const DRAFT_2020_12_SCHEMA_URIS: ReadonlySet<string> = new Set([
  "https://json-schema.org/draft/2020-12/schema",
]);

function schemaDialect(schema: JsonSchemaType): SchemaDialect {
  if (!("$schema" in schema) || typeof schema.$schema !== "string") {
    return { status: "unstamped" };
  }
  return {
    status: "stamped",
    uri: schema.$schema.endsWith("#") ? schema.$schema.slice(0, -1) : schema.$schema,
  };
}

export interface ToolArgumentValidationIssue {
  instancePath: string;
  keyword: string;
  message: string;
}

export interface PreparedToolArguments {
  args: unknown;
  valid: boolean;
  issues: ToolArgumentValidationIssue[];
  totalIssues: number;
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function issuePath(error: ErrorObject): string {
  if (error.keyword === "required") {
    const missingProperty = (error.params as { missingProperty?: unknown }).missingProperty;
    if (typeof missingProperty === "string") {
      return `${error.instancePath}/${escapeJsonPointerSegment(missingProperty)}` || "/";
    }
  }
  return error.instancePath || "/";
}

function createAjvForSchema(schema: JsonSchemaType): Ajv {
  const dialect = schemaDialect(schema);
  if (dialect.status === "unstamped" || DRAFT_2020_12_SCHEMA_URIS.has(dialect.uri)) {
    const Ajv2020 = Ajv2020Import as unknown as typeof Ajv;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    return ajv;
  }
  if (!DRAFT_07_SCHEMA_URIS.has(dialect.uri)) {
    throw new Error(`Unsupported JSON Schema dialect: ${dialect.uri}`);
  }
  const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true });
  addFormats(ajv);
  return ajv;
}

/**
 * Recover one model-emitted JSON layer for schema-declared object/array
 * properties, then validate without scalar coercion. Returned issues are
 * bounded and contain schema paths/messages only, never submitted values.
 */
export function prepareAndValidateToolArguments(
  inputSchema: unknown,
  args: unknown,
  maxIssues = 8,
): PreparedToolArguments {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    throw new Error("MCP tool metadata does not contain a usable input schema");
  }
  const schema = inputSchema as Record<string, unknown>;
  const input = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : null;
  const properties = schema.type === "object" ? schema.properties : undefined;
  let prepared: Record<string, unknown> | undefined;

  if (input && properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(input, name) || typeof input[name] !== "string"
        || !propertySchema || typeof propertySchema !== "object" || Array.isArray(propertySchema)) continue;
      const expectedType = (propertySchema as Record<string, unknown>).type;
      if (expectedType !== "object" && expectedType !== "array") continue;
      try {
        const parsed: unknown = JSON.parse(input[name] as string);
        const matches = expectedType === "array"
          ? Array.isArray(parsed)
          : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
        if (matches) {
          prepared ??= { ...input };
          prepared[name] = parsed;
        }
      } catch {
        // Validation below reports the schema type mismatch without echoing the value.
      }
    }
  }

  const candidate = prepared ?? args;
  const validate = createAjvForSchema(schema as JsonSchemaType).compile(schema);
  const valid = validate(candidate) === true;
  const allIssues = (validate.errors ?? []).map((error) => ({
    instancePath: issuePath(error),
    keyword: error.keyword,
    message: error.message ?? "does not match the schema",
  }));
  return {
    args: candidate,
    valid,
    issues: allIssues.slice(0, Math.max(0, maxIssues)),
    totalIssues: allIssues.length,
  };
}

export function createJsonSchemaValidator(): JsonSchemaValidatorProvider {
  let draft07Validator: AjvJsonSchemaValidator | undefined;
  let draft2020Validator: AjvJsonSchemaValidator | undefined;

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      const dialect = schemaDialect(schema);
      if (dialect.status === "unstamped" || DRAFT_2020_12_SCHEMA_URIS.has(dialect.uri)) {
        draft2020Validator ??= (() => {
          const Ajv2020 = Ajv2020Import as unknown as typeof Ajv;
          const ajv = new Ajv2020({ strict: false, allErrors: true });
          addFormats(ajv);
          return new AjvJsonSchemaValidator(ajv);
        })();
        return draft2020Validator.getValidator<T>(schema);
      }
      if (!DRAFT_07_SCHEMA_URIS.has(dialect.uri)) {
        throw new Error(`Unsupported JSON Schema dialect: ${dialect.uri}`);
      }

      draft07Validator ??= (() => {
        const ajv = new Ajv({
          strict: false,
          validateFormats: true,
          validateSchema: false,
          allErrors: true,
        });
        addFormats(ajv);
        return new AjvJsonSchemaValidator(ajv);
      })();
      return draft07Validator.getValidator<T>(schema);
    },
  };
}
