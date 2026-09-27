import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * Unmount between tests.
 *
 * Testing Library does this automatically only when Vitest's globals are on,
 * and they are not — an implicit `describe` is exactly the kind of ambient
 * magic this workspace avoids elsewhere. Without it a second `render` leaves
 * the first still mounted, and a query for "the sign-out button" finds two.
 *
 * It lives in a setup file rather than in each test because it is the kind of
 * line that gets forgotten in the third file, and the failure it causes looks
 * like a bug in the component.
 */
afterEach(() => {
  cleanup();
});
