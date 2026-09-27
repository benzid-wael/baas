export interface RuyaConfig {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * TCS BaNCS demands these on every call and answers unhelpfully without
   * them, so they are required rather than optional.
   */
  readonly entity: string;
  readonly languageCode: number;
  readonly userId: number;
  readonly channelId: number;
  readonly httpTimeoutMs: number;
  /** Refresh this many seconds before the token actually expires. */
  readonly tokenRefreshBufferSeconds: number;
  readonly maxRetries: number;
}
