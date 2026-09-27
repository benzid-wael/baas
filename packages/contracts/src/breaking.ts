import type { OpenApiDocument } from "./openapi.js";

/**
 * Detect changes that break an existing client.
 *
 * Not a general OpenAPI differ. It covers the changes that actually break the
 * mobile app and the BFF:
 *
 *   structural — a path, operation, response, property or schema disappears;
 *                a property's type changes
 *   contractual — a property's required-ness changes in either direction
 *   value-level — an enum's membership changes in either direction; a
 *                 `pattern` or `format` changes; a length or numeric bound
 *                 tightens
 *
 * **Both directions, deliberately.** A component schema here is referenced
 * from request and response positions alike, and the two break oppositely:
 *
 *   adding an enum member       breaks a *consumer* switching exhaustively
 *   removing an enum member     breaks a *producer* still sending it
 *   a property becoming required breaks a producer
 *   a property ceasing to be required breaks a consumer that assumed it
 *
 * Without per-path analysis the detector cannot know which position a schema
 * occupies, so it reports both and names which risk each one is. The version
 * bump is the acknowledgement. For a banking API whose mobile client switches
 * on payment and outcome states, a new status genuinely is a client-visible
 * change, so erring towards reporting is the right direction.
 *
 * Still not covered, and stated rather than implied: a widened numeric bound
 * that overflows a client's integer type, a semantic change behind an
 * unchanged shape, and anything about behaviour.
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
    // Recursion compares the child's own constraints on the way out, so this
    // loop must not also compare them or every finding is reported twice.
    compareObjectSchema(`${where}.${property}`, definition, successor, changes);
  }

  const previousRequired = new Set(asStringArray(asRecord(before)["required"]));
  const nextRequired = new Set(asStringArray(asRecord(after)["required"]));
  for (const property of nextRequired) {
    if (!previousRequired.has(property)) {
      changes.push({
        path: `${where}.${property}`,
        reason: "property became required, which breaks a producer omitting it",
      });
    }
  }
  for (const property of previousRequired) {
    if (!nextRequired.has(property) && property in nextProperties) {
      changes.push({
        path: `${where}.${property}`,
        reason:
          "property is no longer required, which breaks a consumer assuming it is present",
      });
    }
  }

  // A schema can be a bare enum or a constrained scalar with no properties at
  // all, so the top level is compared too.
  compareConstraints(where, before, after, changes);

  // And descend into array items. Without this, a narrowed enum or a changed
  // pattern **inside a list** is invisible — which it was, until a capability
  // report's `operations: string[]` changed its pattern and the detector
  // reported the document merely stale.
  const previousItems = asRecord(before)["items"];
  const nextItems = asRecord(after)["items"];
  if (previousItems !== undefined && nextItems !== undefined) {
    compareObjectSchema(`${where}[]`, previousItems, nextItems, changes);
  }
}

/**
 * Value-level constraints. Tightening breaks; loosening does not, except for
 * enums and opaque constraints where both directions carry a risk worth
 * naming.
 */
function compareConstraints(
  where: string,
  before: unknown,
  after: unknown,
  changes: BreakingChange[],
): void {
  const previous = asRecord(before);
  const next = asRecord(after);

  compareEnum(where, previous, next, changes);

  for (const key of ["pattern", "format"] as const) {
    const was = previous[key];
    const now = next[key];
    if (was !== undefined && now !== was) {
      changes.push({
        path: where,
        reason:
          now === undefined
            ? `${key} removed`
            : `${key} changed from ${JSON.stringify(was)} to ${JSON.stringify(now)}`,
      });
    }
  }

  // Tightening only: a smaller ceiling or a larger floor rejects values that
  // were previously accepted.
  for (const [key, direction] of [
    ["maxLength", "lower"],
    ["maximum", "lower"],
    ["maxItems", "lower"],
    ["minLength", "higher"],
    ["minimum", "higher"],
    ["minItems", "higher"],
  ] as const) {
    const was = previous[key];
    const now = next[key];
    if (typeof was !== "number" || typeof now !== "number") {
      continue;
    }
    const tightened = direction === "lower" ? now < was : now > was;
    if (tightened) {
      changes.push({
        path: where,
        reason: `${key} tightened from ${was.toString()} to ${now.toString()}`,
      });
    }
  }
}

function compareEnum(
  where: string,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  changes: BreakingChange[],
): void {
  const was = previous["enum"];
  const now = next["enum"];
  if (!Array.isArray(was) || !Array.isArray(now)) {
    return;
  }
  const before = new Set(was.map((value) => JSON.stringify(value)));
  const after = new Set(now.map((value) => JSON.stringify(value)));

  const removed = [...before].filter((value) => !after.has(value));
  const added = [...after].filter((value) => !before.has(value));

  if (removed.length > 0) {
    changes.push({
      path: where,
      reason: `enum removed ${removed.join(", ")}, which breaks a producer still sending it`,
    });
  }
  if (added.length > 0) {
    changes.push({
      path: where,
      reason: `enum added ${added.join(", ")}, which breaks a consumer switching exhaustively`,
    });
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
