/**
 * Validate an environment without deploying it.
 *
 * `pnpm check:config` reads the current environment through the same loader
 * the service uses at boot and exits non-zero, listing every problem, if the
 * contract does not hold. This exists so that a manifest can be checked in CI
 * or against a shell before it reaches a cluster — the incumbent's equivalent
 * failure mode is a pod that crash-loops with one rule at a time.
 */
import { SystemClock } from "../clock.js";
import { ConfigurationError, loadConfig } from "./load.js";

export function checkConfig(
  env: NodeJS.ProcessEnv,
  write: (line: string) => void,
): number {
  try {
    const config = loadConfig(env, { clock: new SystemClock() });
    write(
      `configuration is valid for APP_ENV=${config.global.appEnv} ` +
        `(${config.tenants.size.toString()} tenant${config.tenants.size === 1 ? "" : "s"})`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      write(error.message);
      return 1;
    }
    throw error;
  }
}

/* c8 ignore start -- process wiring, exercised by `pnpm check:config` */
if (process.argv[1]?.endsWith("check.js") === true) {
  process.exitCode = checkConfig(process.env, (line) => {
    process.stderr.write(`${line}\n`);
  });
}
/* c8 ignore stop */
