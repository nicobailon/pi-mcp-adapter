import { Ajv } from "ajv";
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
