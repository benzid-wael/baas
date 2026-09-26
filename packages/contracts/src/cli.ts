/**
 * Generate or verify the committed OpenAPI document.
 *
 *   pnpm openapi:generate   rewrite openapi.json from the registry
 *   pnpm check:openapi      fail if it is stale, or if it changed in a way
 *                           that breaks a client without a version bump
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildRegistry, OPENAPI_TITLE, OPENAPI_VERSION } from "./contracts.js";
import { buildOpenApiDocument, serializeDocument } from "./openapi.js";
import type { OpenApiDocument } from "./openapi.js";
import { findBreakingChanges } from "./breaking.js";

export function currentDocument(): OpenApiDocument {
  return buildOpenApiDocument(buildRegistry(), {
    title: OPENAPI_TITLE,
    version: OPENAPI_VERSION,
  });
}

export interface CheckResult {
  readonly code: number;
  readonly lines: readonly string[];
}

export function checkDocument(
  committed: string | undefined,
  generated: OpenApiDocument,
): CheckResult {
  const serialized = serializeDocument(generated);
  if (committed === undefined) {
    return {
      code: 1,
      lines: ["openapi.json is missing. Run `pnpm openapi:generate`."],
    };
  }
  if (committed === serialized) {
    return { code: 0, lines: ["openapi.json is up to date."] };
  }

  const previous = JSON.parse(committed) as OpenApiDocument;
  const breaking = findBreakingChanges(previous, generated);
  const lines = ["openapi.json is stale. Run `pnpm openapi:generate`."];

  if (breaking.length > 0) {
    const bumped = previous.info.version !== generated.info.version;
    lines.push(
      `${breaking.length.toString()} breaking change${breaking.length === 1 ? "" : "s"}:`,
      ...breaking.map((change) => `  - ${change.path}: ${change.reason}`),
    );
    if (!bumped) {
      lines.push(
        `OPENAPI_VERSION is still ${previous.info.version}. A breaking change requires an explicit bump.`,
      );
    } else {
      lines.push(
        `OPENAPI_VERSION was bumped ${previous.info.version} -> ${generated.info.version}, so the break is deliberate.`,
      );
    }
  }
  return { code: 1, lines };
}

/* c8 ignore start -- process and filesystem wiring, exercised by the pnpm scripts */
function readCommitted(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

if (process.argv[1]?.endsWith("cli.js") === true) {
  const target = process.argv[3] ?? "openapi.json";
  const document = currentDocument();
  if (process.argv[2] === "--write") {
    writeFileSync(target, serializeDocument(document), "utf8");
    process.stderr.write(`wrote ${target}\n`);
  } else {
    const result = checkDocument(readCommitted(target), document);
    for (const line of result.lines) {
      process.stderr.write(`${line}\n`);
    }
    process.exitCode = result.code;
  }
}
/* c8 ignore stop */
