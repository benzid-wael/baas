import type { PortalConfig } from "./config.js";

/**
 * The operator API, as the browser sees it.
 *
 * Deliberately thin and hand-written. The mobile SDK is generated from the
 * OpenAPI document (New-11); this is not, because the operator surface is
 * consumed by exactly one client that lives in the same repository, and a
 * generator between them would add a build step to buy a guarantee that a
 * failing type-check already gives.
 */
export class ApiError extends Error {
  readonly code = "portal.api.failed";

  constructor(
    readonly status: number,
    /** Our own wording. A provider's or a framework's is not shown to anyone. */
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Session {
  readonly token: string;
  readonly expiresAt: string;
  /**
   * What this operator may do, so a control can be disabled *with a reason*
   * rather than offered and then refused (finding F1).
   *
   * Not a security control. Every route is guarded server-side and a browser
   * can claim anything; this only decides what the screen says.
   */
  readonly roles: readonly string[];
}

export class ApiClient {
  /**
   * In memory, for the life of the tab.
   *
   * **Not `localStorage`.** A session that reads any customer in the tenant
   * surviving a closed tab is a session someone else's hands find later, and
   * any script on the origin can read it. Closing the tab signs out, which is
   * the behaviour people already expect from a console like this.
   */
  private session: Session | undefined;

  constructor(
    private readonly config: PortalConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get signedIn(): boolean {
    return this.session !== undefined;
  }

  /** Empty when signed out, which renders as "you cannot do this". */
  get roles(): readonly string[] {
    return this.session?.roles ?? [];
  }

  /** When the session lapses, so the shell can say so before it does (F1). */
  get expiresAt(): string | undefined {
    return this.session?.expiresAt;
  }

  /** Exchange a verified identity-provider token for a `baas` session. */
  async signIn(idToken: string): Promise<void> {
    this.session = await this.request<Session>("POST", "/operator/sessions", {
      idToken,
    });
  }

  async signOut(): Promise<void> {
    if (this.session === undefined) {
      return;
    }
    try {
      await this.request("DELETE", "/operator/sessions/current");
    } finally {
      // Forgotten locally whatever the server said. A sign-out that leaves the
      // token in the tab because the network blipped is not a sign-out.
      this.session = undefined;
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  /** `remove`, not `delete`: the latter is a reserved word as a method name. */
  remove<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.session === undefined
          ? {}
          : { authorization: `Bearer ${this.session.token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 401) {
      // The session is gone — revoked, expired, or the server restarted.
      // Dropping it here means the next render shows the sign-in screen rather
      // than a wall of failing requests.
      this.session = undefined;
      throw new ApiError(401, "Your session has ended. Sign in again.");
    }
    if (!response.ok) {
      throw new ApiError(response.status, describe(response.status));
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}

/**
 * What the operator is told.
 *
 * Our own wording, never the server's. Finding F3: the incumbent's portal
 * renders a provider's error text straight into the page, which is both
 * unreadable and a way for a bank's phrasing — sometimes carrying an account
 * number — to reach a screen and a screenshot.
 */
function describe(status: number): string {
  if (status === 403) {
    return "You do not have permission to do that.";
  }
  if (status === 404) {
    return "Not found.";
  }
  if (status >= 500) {
    return "Something went wrong at our end. Try again shortly.";
  }
  return "That request could not be completed.";
}
