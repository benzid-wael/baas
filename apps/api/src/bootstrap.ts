import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { Clock, IdGenerator } from "@baas/domain";
import type { Config, Logger } from "@baas/platform";
import type { Database } from "@baas/persistence";
import type { ProviderBuildResult } from "@baas/provider-registry";
import { AppModule } from "./app.module.js";
import { composeApi } from "./composition.js";

export interface BootstrapOptions {
  readonly config: Config;
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly tenantId: string;
  readonly providers?: readonly ProviderBuildResult[];
}

/**
 * Build the whole application (New-18).
 *
 * Separate from `main.ts` so it can be built without being started: the
 * whole-application test in `apps/e2e` calls this, which is what makes the
 * route-drift check meaningful in both directions. A composition that only
 * ever runs as a process is a composition nothing can assert against.
 */
export async function buildApiApplication(
  options: BootstrapOptions,
): Promise<INestApplication> {
  const graph = composeApi(options);
  const app = await NestFactory.create(
    AppModule.withDependencies(graph.dependencies),
    {
      logger: false,
    },
  );

  // CORS is a list, never `*`: the portal is a browser origin carrying a
  // session, and a wildcard there would make every site on the internet a
  // client of the operator console.
  const origins = options.config.global.corsOrigins;
  if (origins.length > 0) {
    app.enableCors({ origin: [...origins], credentials: true });
  }

  await app.init();
  return app;
}
