/**
 * Entrypoint. `pnpm sim` runs the partner simulator on PORT (default 4010).
 *
 * Configured by environment rather than by the service's own config schema:
 * this is a development tool and must start with nothing set.
 */
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { SystemClock, UuidV7Generator, createLogger } from "@baas/platform";
import { createSimulatorServer } from "./server.js";
import { Simulator } from "./simulator.js";

/* c8 ignore start -- process wiring, exercised by running the app */
const logger = createLogger({
  service: "provider-sim",
  environment: process.env["APP_ENV"] ?? "dev",
  level: "debug",
  additionalFields: ["port", "mode"],
});

const keelPrivateKeyPem =
  process.env["SIM_KEEL_PRIVATE_KEY"] ??
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;

const simulator = new Simulator({
  clock: new SystemClock(),
  ids: new UuidV7Generator(),
  credentials: {
    keelPrivateKeyPem,
    ruyaSecret:
      process.env["SIM_RUYA_SECRET"] ?? randomBytes(32).toString("hex"),
  },
  targets: {
    ...(process.env["SIM_KEEL_WEBHOOK_URL"] === undefined
      ? {}
      : { keel: process.env["SIM_KEEL_WEBHOOK_URL"] }),
    ...(process.env["SIM_RUYA_WEBHOOK_URL"] === undefined
      ? {}
      : { ruya: process.env["SIM_RUYA_WEBHOOK_URL"] }),
  },
});

const port = Number(process.env["PORT"] ?? 4010);
createSimulatorServer({ simulator, logger }).listen(port, () => {
  logger.info({ port }, "provider simulator listening");
});
/* c8 ignore stop */
