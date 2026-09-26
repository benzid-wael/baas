import { describe, expect, it } from "vitest";
import { isHardened, resolveAppEnv } from "./app-env.js";

describe("resolveAppEnv", () => {
  it("uses APP_ENV when it is one of the allowed tiers", () => {
    expect(resolveAppEnv({ APP_ENV: "stage" })).toBe("stage");
    expect(resolveAppEnv({ APP_ENV: "production" })).toBe("production");
    expect(resolveAppEnv({ APP_ENV: "dev" })).toBe("dev");
  });

  it.each(["staging", "prod", "PRODUCTION", "development", "x"])(
    "refuses %o rather than guessing",
    (value) => {
      expect(resolveAppEnv({ APP_ENV: value })).toBeUndefined();
    },
  );

  it("defaults to the strict tier when the image says production", () => {
    // The image pins NODE_ENV=production, so an unset APP_ENV can only ever
    // make the service stricter. Relaxing must be explicit.
    expect(resolveAppEnv({ NODE_ENV: "production" })).toBe("production");
  });

  it("defaults to dev otherwise", () => {
    expect(resolveAppEnv({})).toBe("dev");
    expect(resolveAppEnv({ NODE_ENV: "development" })).toBe("dev");
    expect(resolveAppEnv({ APP_ENV: "" })).toBe("dev");
  });

  it("never lets NODE_ENV override an explicit tier", () => {
    expect(resolveAppEnv({ APP_ENV: "dev", NODE_ENV: "production" })).toBe(
      "dev",
    );
  });

  it("holds stage to the production contract", () => {
    expect(isHardened("production")).toBe(true);
    expect(isHardened("stage")).toBe(true);
    expect(isHardened("dev")).toBe(false);
  });
});
