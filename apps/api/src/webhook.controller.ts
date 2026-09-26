import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { Public } from "./decorators.js";
import type { Inbox } from "@baas/persistence";

/**
 * Webhook ingress: **record, do not process** (RFC-BaaS §5.6, finding C2).
 *
 * The endpoint verifies the signature, writes the body verbatim, and returns.
 * Nothing downstream can lose the delivery, because nothing downstream has
 * run. The reconciler picks it up from the inbox on its own schedule.
 *
 * Deliberately `@Public()`: a partner cannot hold an API-client credential.
 * The signature is the authentication, and the route declares that policy
 * explicitly rather than inheriting one by omission.
 */
export const WEBHOOK_VERIFIER = "baas:WebhookVerifier";
export const WEBHOOK_INBOX = "baas:WebhookInbox";

export interface WebhookVerifier {
  verify(
    providerId: string,
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): boolean;
  /** Which tenant a provider's callback belongs to, from the credential. */
  tenantFor(providerId: string): string | undefined;
  interpret(payload: unknown): {
    externalEventId: string | null;
    eventType: string | null;
    providerRef: string | null;
  };
}

@Controller("webhooks")
export class WebhookController {
  constructor(
    @Inject(WEBHOOK_INBOX) private readonly inbox: Inbox,
    @Inject(WEBHOOK_VERIFIER) private readonly verifier: WebhookVerifier,
  ) {}

  @Post(":provider")
  @Public()
  @HttpCode(202)
  async receive(
    @Param("provider") provider: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<{ received: true }> {
    const tenantId = this.verifier.tenantFor(provider);
    if (tenantId === undefined) {
      // An unknown provider is recorded nowhere and accepted anyway: telling a
      // caller which provider ids exist is free reconnaissance.
      return { received: true };
    }

    const raw = JSON.stringify(body);
    const verified = this.verifier.verify(provider, raw, headers);
    const shape = this.verifier.interpret(body);

    // A rejected signature is stored too. Dropping it erases the only evidence
    // that someone is probing the endpoint, and makes a misconfigured partner
    // indistinguishable from a silent one.
    await this.inbox.record({
      tenantId,
      providerId: provider,
      externalEventId: shape.externalEventId,
      eventType: shape.eventType,
      providerRef: shape.providerRef,
      signatureVerified: verified,
      payload: body,
    });

    // Always 202. A partner that retries on a non-2xx would retry on a bad
    // signature forever, and telling it the signature was wrong tells an
    // attacker the same thing.
    return { received: true };
  }
}
