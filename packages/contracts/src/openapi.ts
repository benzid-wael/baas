import { z } from "zod";
import type { ContractRegistry, OperationSpec } from "./registry.js";

/**
 * Build the OpenAPI document from the registry.
 *
 * OpenAPI 3.1 schemas *are* JSON Schema, so zod 4's own `toJSONSchema` is
 * sufficient and no zod-to-OpenAPI library is needed. One fewer dependency on
 * the path between a schema change and the published contract.
 *
 * The document is deterministic: schemas are emitted in sorted order, so a
 * regeneration that changes nothing produces a byte-identical file and the CI
 * diff means what it says.
 */
export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Record<string, unknown>;
  readonly components: { readonly schemas: Record<string, unknown> };
}

export interface BuildOptions {
  readonly title: string;
  /**
   * Bumped by hand when a breaking change is intended. `check:openapi` refuses
   * a breaking change that leaves it alone.
   */
  readonly version: string;
}

export function buildOpenApiDocument(
  registry: ContractRegistry,
  options: BuildOptions,
): OpenApiDocument {
  const schemas: Record<string, unknown> = {};
  for (const name of [...registry.schemas.keys()].sort()) {
    const schema = registry.schemas.get(name);
    /* c8 ignore next 3 -- unreachable: the key came from this map */
    if (schema === undefined) {
      continue;
    }
    schemas[name] = z.toJSONSchema(schema, {
      io: "output",
      target: "draft-2020-12",
    });
  }

  const paths: Record<string, unknown> = {};
  for (const route of [...registry.paths.keys()].sort()) {
    const item = registry.paths.get(route);
    /* c8 ignore next 3 -- unreachable: the key came from this map */
    if (item === undefined) {
      continue;
    }
    const methods: Record<string, unknown> = {};
    for (const method of Object.keys(item).sort()) {
      const operation = item[method];
      /* c8 ignore next 3 -- unreachable: the key came from this object */
      if (operation === undefined) {
        continue;
      }
      methods[method] = renderOperation(operation);
    }
    paths[route] = methods;
  }

  return {
    openapi: "3.1.0",
    info: { title: options.title, version: options.version },
    paths,
    components: { schemas },
  };
}

function renderOperation(operation: OperationSpec): unknown {
  const responses: Record<string, unknown> = {};
  for (const status of Object.keys(operation.responses).sort()) {
    const response = operation.responses[status];
    /* c8 ignore next 3 -- unreachable: the key came from this object */
    if (response === undefined) {
      continue;
    }
    responses[status] = {
      description: response.description,
      ...(response.schema === undefined
        ? {}
        : {
            content: { "application/json": { schema: ref(response.schema) } },
          }),
    };
  }

  return {
    operationId: operation.operationId,
    summary: operation.summary,
    ...(operation.requestBody === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: ref(operation.requestBody) },
            },
          },
        }),
    responses,
  };
}

function ref(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

/** Stable serialisation, so the committed document and CI cannot disagree. */
export function serializeDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
