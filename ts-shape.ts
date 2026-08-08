type Schema = Record<string, unknown>;

const UNSUPPORTED_KEYWORDS = ["if", "then", "else", "allOf", "not", "patternProperties", "additionalProperties"];

/** Renders the useful JSON Schema subset as TypeScript, or null for unsupported schemas. */
export function renderTsShape(inputSchema: unknown): string | null {
  try {
    if (!isSchema(inputSchema)) return null;

    const definitions = new Map<string, Schema>();
    for (const key of ["$defs", "definitions"]) {
      const rawDefinitions = inputSchema[key];
      if (rawDefinitions === undefined) continue;
      if (!isSchema(rawDefinitions)) return null;
      for (const [name, definition] of Object.entries(rawDefinitions)) {
        if (!isSchema(definition)) return null;
        definitions.set(`${key}/${decodePointerToken(name)}`, definition);
      }
    }

    const aliases = new Map<string, string>();
    const usedAliases = new Set<string>();
    let aliasIndex = 0;
    const aliasFor = (definitionKey: string) => {
      let alias = aliases.get(definitionKey);
      if (alias) return alias;
      const name = definitionKey.slice(definitionKey.indexOf("/") + 1);
      alias = /^[A-Za-z_$][\w$]*$/.test(name) && !usedAliases.has(name) ? name : `Definition${++aliasIndex}`;
      while (usedAliases.has(alias)) alias = `Definition${++aliasIndex}`;
      aliases.set(definitionKey, alias);
      usedAliases.add(alias);
      return alias;
    };

    const render = (schema: unknown): string | null => {
      if (!isSchema(schema) || hasUnsupportedKeyword(schema)) return null;

      if ("$ref" in schema) {
        if (typeof schema.$ref !== "string") return null;
        const match = schema.$ref.match(/^#\/(\$defs|definitions)\/([^/]+)$/);
        if (!match) return null;
        const definitionGroup = match[1];
        const definitionName = match[2];
        if (definitionGroup === undefined || definitionName === undefined) return null;
        const definitionKey = `${definitionGroup}/${decodePointerToken(definitionName)}`;
        if (!definitions.has(definitionKey)) return null;
        return aliasFor(definitionKey);
      }

      if (Array.isArray(schema.enum)) {
        const values = schema.enum.map(renderLiteral);
        return values.every((value): value is string => value !== null) ? values.join(" | ") : null;
      }
      if (Object.hasOwn(schema, "const")) return renderLiteral(schema.const);

      if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
        const variants = (schema.anyOf ?? schema.oneOf) as unknown[];
        if (variants.length === 0) return null;
        const rendered = variants.map(render);
        return rendered.every((value): value is string => value !== null) ? rendered.join(" | ") : null;
      }

      if (schema.type === "object" || schema.properties !== undefined) {
        if (schema.properties === undefined) return "{}";
        if (!isSchema(schema.properties)) return null;
        const required = new Set(Array.isArray(schema.required)
          ? schema.required.filter((name): name is string => typeof name === "string")
          : []);
        const properties: string[] = [];
        for (const [name, property] of Object.entries(schema.properties)) {
          const rendered = render(property);
          if (rendered === null) return null;
          properties.push(`${formatPropertyName(name)}${required.has(name) ? "" : "?"}: ${rendered};`);
        }
        return properties.length === 0 ? "{}" : `{ ${properties.join(" ")} }`;
      }

      if (schema.type === "array") {
        if (schema.items === undefined) return "unknown[]";
        const item = render(schema.items);
        return item === null ? null : `${needsParentheses(item) ? `(${item})` : item}[]`;
      }

      if (Array.isArray(schema.type)) {
        const types = schema.type.map(renderType);
        return types.every((type): type is string => type !== null) ? types.join(" | ") : null;
      }
      if (typeof schema.type === "string") return renderType(schema.type);
      return "unknown";
    };

    const root = render(inputSchema);
    if (root === null) return null;

    const definitionsText: string[] = [];
    for (const [key, alias] of aliases) {
      const definition = definitions.get(key);
      if (!definition) return null;
      const rendered = render(definition);
      if (rendered === null) return null;
      definitionsText.push(`type ${alias} = ${rendered};`);
    }
    return definitionsText.length > 0 ? `${definitionsText.join("\n")}\n\n${root}` : root;
  } catch {
    return null;
  }
}

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnsupportedKeyword(schema: Schema): boolean {
  return UNSUPPORTED_KEYWORDS.some(keyword => {
    if (!Object.hasOwn(schema, keyword)) return false;
    // `additionalProperties: false` is a closed-object constraint, not a shape that this renderer needs to understand.
    return keyword !== "additionalProperties" || schema.additionalProperties !== false;
  });
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function renderType(type: unknown): string | null {
  switch (type) {
    case "string": return "string";
    case "number":
    case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "object": return "{}";
    case "array": return "unknown[]";
    default: return null;
  }
}

function renderLiteral(value: unknown): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function formatPropertyName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function needsParentheses(type: string): boolean {
  return type.includes(" | ");
}
