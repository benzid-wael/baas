import type { z } from "zod";

/**
 * The named schemas that appear in the OpenAPI document.
 *
 * A schema reaches the document by being registered here, and by nothing else.
 * That makes the document's surface a list someone can read, rather than
 * whatever a decorator scan happened to find — which is how the incumbent
 * ended up publishing DTOs nobody intended to expose.
 */
export interface ContractRegistry {
  readonly schemas: ReadonlyMap<string, z.ZodType>;
  readonly paths: ReadonlyMap<string, PathItem>;
}

export interface PathItem {
  readonly [method: string]: OperationSpec;
}

export interface OperationSpec {
  readonly operationId: string;
  readonly summary: string;
  readonly requestBody?: string;
  readonly responses: Readonly<Record<string, ResponseSpec>>;
}

export interface ResponseSpec {
  readonly description: string;
  /** Name of a registered schema, or absent for an empty body. */
  readonly schema?: string;
}

export class RegistryBuilder {
  private readonly schemas = new Map<string, z.ZodType>();
  private readonly paths = new Map<string, PathItem>();

  schema(name: string, schema: z.ZodType): this {
    if (this.schemas.has(name)) {
      throw new DuplicateContractError("schema", name);
    }
    this.schemas.set(name, schema);
    return this;
  }

  path(route: string, item: PathItem): this {
    if (this.paths.has(route)) {
      throw new DuplicateContractError("path", route);
    }
    this.paths.set(route, item);
    return this;
  }

  build(): ContractRegistry {
    for (const [route, item] of this.paths) {
      for (const [method, operation] of Object.entries(item)) {
        for (const name of referencedSchemas(operation)) {
          if (!this.schemas.has(name)) {
            throw new UnregisteredSchemaError(name, `${method} ${route}`);
          }
        }
      }
    }
    return { schemas: new Map(this.schemas), paths: new Map(this.paths) };
  }
}

function referencedSchemas(operation: OperationSpec): readonly string[] {
  const names: string[] = [];
  if (operation.requestBody !== undefined) {
    names.push(operation.requestBody);
  }
  for (const response of Object.values(operation.responses)) {
    if (response.schema !== undefined) {
      names.push(response.schema);
    }
  }
  return names;
}

export class DuplicateContractError extends Error {
  readonly code = "contracts.duplicate";

  constructor(kind: string, name: string) {
    super(`Duplicate ${kind} in the contract registry: ${name}`);
    this.name = "DuplicateContractError";
  }
}

export class UnregisteredSchemaError extends Error {
  readonly code = "contracts.unregistered_schema";

  constructor(name: string, usedBy: string) {
    super(`${usedBy} references schema "${name}", which is not registered`);
    this.name = "UnregisteredSchemaError";
  }
}
