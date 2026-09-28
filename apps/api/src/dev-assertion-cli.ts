/**
 * `pnpm assertion` — print the headers that call the mobile surface by hand.
 *
 * A separate entrypoint for the same reason `seed-cli.ts` is: it mints a
 * credential that impersonates a customer, and something that prints one
 * should be something a person ran on purpose.
 */
import { SystemClock, createLogger, loadConfig } from "@baas/platform";
import { SeedRefusedError } from "./seed.js";
import { DEMO_EXTERNAL_USER_UUID } from "./demo-data.js";
import { generateDevKeyPair, mintAssertion } from "./dev-assertion.js";

/* c8 ignore start -- process wiring, exercised by running the command */
const clock = new SystemClock();
const config = loadConfig(process.env, { clock });
const logger = createLogger({
  service: "dev-assertion",
  environment: config.global.appEnv,
  level: "error",
});

try {
  if (config.global.appEnv !== "dev") {
    throw new SeedRefusedError(config.global.appEnv);
  }

  const subject = process.argv[2] ?? DEMO_EXTERNAL_USER_UUID;
  // A fresh pair unless one is supplied. Generating is the default so that the
  // easy path cannot accidentally be "reuse whatever key is lying around".
  const supplied = process.env["DEV_ASSERTION_PRIVATE_KEY"];
  const pair = supplied === undefined ? generateDevKeyPair() : undefined;
  const privateKeyPem =
    supplied ?? /* c8 ignore next */ pair?.privateKeyPem ?? "";

  const assertion = mintAssertion(clock, {
    appEnv: config.global.appEnv,
    privateKeyPem,
    issuer: config.global.mobileAssertion.issuer,
    audience: config.global.mobileAssertion.audience,
    externalUserUuid: subject,
  });

  const lines = [""];
  if (pair !== undefined) {
    lines.push(
      "  A throwaway key pair was generated. The service must hold the public",
      "  half, so put this in .env and restart the API:",
      "",
      `    MOBILE_ASSERTION_PUBLIC_KEY=${pair.publicKeyBase64}`,
      "",
      "  To mint more assertions against the same key, export the private half.",
      "  Single-line base64, because a multi-line PEM does not survive a shell",
      "  export or a copy-paste:",
      "",
      `    export DEV_ASSERTION_PRIVATE_KEY=${pair.privateKeyBase64}`,
      "",
    );
  }
  lines.push(
    "  Call the mobile surface with these headers (valid for 60 seconds):",
    "",
    `    X-SC-USER-UUID:      ${subject}`,
    `    X-SC-USER-ASSERTION: ${assertion}`,
    "",
    "  The client id and secret come from `pnpm seed`.",
    "",
  );
  process.stdout.write(lines.join("\n"));
} catch (error) {
  logger.fatal({ err: error }, "could not mint an assertion");
  process.exit(1);
}
/* c8 ignore stop */
