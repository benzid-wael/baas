import type { OpenApiDocument } from "./openapi.js";

/**
 * Detect changes that break an existing client.
 *
 * Not a general OpenAPI differ. It covers the changes that actually break the
 * mobile app and the BFF, and says so explicitly rather than implying
 * completeness:
 *
 *   - a path or operation disappears
 *   - a response status disappears
 *   - a property disappears from a schema
 *   - a property becomes required that was not
 *   - a property's type changes
 *
 * Additive changes — a new path, a new optional property, a new response —
 * are not breaking and pass without a version bump.
 *
 * What it does **not** catch, and should not be trusted for: a narrowed
 * `enum`, a tightened `pattern` or `maxLength`, a changed `format`. Those
 * break a client at runtime rather than at compile time. Widening the detector
 * to cover constraint narrowing is New-10.
 */
export interface BreakingChange {
  readonly path: string;
  readonly reason: string;
}

export function findBreakingChanges(
  before: OpenApiDocument,
  after: OpenApiDocument,
): readonly BreakingChange[] {
  const changes: BreakingChange[] = [];
  comparePaths(before, after, changes);
  compareSchemas(before, after, changes);
  return changes;
}

function comparePaths(
  before: OpenApiDocument,
  after: OpenApiDocument,
  changes: BreakingChange[],
): void {
  for (const [route, item] of Object.entries(before.paths)) {
    const successor = after.paths[route];
    if (successor === undefined) {
      changes.push({ path: route, reason: "path removed" });
      continue;
    }
    for (const [method, operation] of Object.entries(asRecord(item))) {
      const next = asRecord(successor)[method];
      if (next === undefined) {
        changes.push({
          path: `${route}.${method}`,
          reason: "operation removed",
        });
        continue;
      }
      compareResponses(`${route}.${method}`, operation, next, changes);
    }
  }
}

function compareResponses(
  where: string,
  before: unknown,
  after: unknown,
  changes: BreakingChange[],
): void {
  const previous = asRecord(asRecord(before)["responses"]);
  const next = asRecord(asRecord(after)["responses"]);
  for (const status of Object.keys(previous)) {
    if (!(status in next)) {
      changes.push({
        path: `${where}.responses.${status}`,
        reason: "response removed",
      });
    }
  }
}

function compareSchemas(
  before: OpenApiDocument,
  after: OpenApiDocument,
  changes: BreakingChange[],
): void {
  for (const [name, schema] of Object.entries(before.components.schemas)) {
    const successor = after.components.schemas[name];
    if (successor === undefined) {
      changes.push({ path: `schemas.${name}`, reason: "schema removed" });
      continue;
    }
    compareObjectSchema(`schemas.${name}`, schema, successor, changes);
  }
}

function compareObjectSchema(
  where: string,
  before: unknown,
  after: unknown,
  changes: BreakingChange[],
): void {
  const previousProperties = asRecord(asRecord(before)["properties"]);
  const nextProperties = asRecord(asRecord(after)["properties"]);

  for (const [property, definition] of Object.entries(previousProperties)) {
    const successor = nextProperties[property];
    if (successor === undefined) {
      changes.push({
        path: `${where}.${property}`,
        reason: "property removed",
      });
      continue;
    }
    const previousType = asRecord(definition)["type"];
    const nextType = asRecord(successor)["type"];
    if (
      previousType !== undefined &&
      nextType !== undefined &&
      JSON.stringify(previousType) !== JSON.stringify(nextType)
    ) {
      changes.push({
        path: `${where}.${property}`,
        reason: `type changed from ${JSON.stringify(previousType)} to ${JSON.stringify(nextType)}`,
      });
    }
    compareObjectSchema(`${where}.${property}`, definition, successor, changes);
  }

  const previousRequired = new Set(asStringArray(asRecord(before)["required"]));
  for (const property of asStringArray(asRecord(after)["required"])) {
    if (!previousRequired.has(property)) {
      changes.push({
        path: `${where}.${property}`,
        reason: "property became required",
      });
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
