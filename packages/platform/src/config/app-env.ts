/**
 * The deployment tier. Everything that hardens in production keys off this.
 *
 * Deliberately **not** `NODE_ENV`. The container image pins
 * `NODE_ENV=production` so that Node itself runs in production mode, which
 * means `NODE_ENV` is identical in dev, stage and production and cannot
 * distinguish them. Gating a security control on it would make every
 * environment look like production, or — worse, and this is the failure that
 * has actually happened on this platform — make production look like dev
 * because someone set it to `development` locally and copied the manifest.
 */
export const APP_ENVS = ["dev", "stage", "production"] as const;

export type AppEnv = (typeof APP_ENVS)[number];

/** Tiers held to the full production contract. */
export const HARDENED_ENVS: ReadonlySet<AppEnv> = new Set<AppEnv>([
  "stage",
  "production",
]);

export function isHardened(appEnv: AppEnv): boolean {
  return HARDENED_ENVS.has(appEnv);
}

/**
 * Resolve the tier, secure by default.
 *
 * When `APP_ENV` is absent we fall back to the strict tier if the image says
 * production, so that an unset variable can only ever make the service
 * *stricter*. Relaxing a deployment must be explicit and visible in the
 * manifest. This is carried over from the incumbent service, where it is one
 * of the controls that demonstrably worked.
 */
export function resolveAppEnv(env: NodeJS.ProcessEnv): AppEnv | undefined {
  const declared = env["APP_ENV"];
  if (declared !== undefined && declared !== "") {
    return APP_ENVS.find((candidate) => candidate === declared);
  }
  return env["NODE_ENV"] === "production" ? "production" : "dev";
}
