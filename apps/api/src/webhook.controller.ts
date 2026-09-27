import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { Public } from "./decorators.js";
import type { Inbox } from "@baas/persistence";
import type { WebhookVerifier } from "@baas/domain";

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

@Controller("webhooks")
export class WebhookController {
  constructor(
    @Inject(WEBHOOK_INBOX) private readonly inbox: Inbox,
    @Inject(WEBHOOK_VERIFIER) private readonly verifier: WebhookVerifier,
  ) {}

  /**
   * The **raw bytes** are what gets verified, never a re-serialisation.
   *
   * This was a live defect until New-21: the handler computed
   * `JSON.stringify(body)` and verified that. Key order, whitespace and
   * unicode escaping are all free to differ from what the partner sent, so
   * every genuine delivery would have been rejected — silently, and only in an
   * environment with a real partner. `rawBody: true` on the Nest application
   * is what makes `request.rawBody` present; without it this route refuses.
   */
  @Post(":provider")
  @Public()
  @HttpCode(202)
  async receive(
    @Param("provider") provider: string,
    @Body() body: unknown,
    @Req() request: RawBodyRequest<{ rawBody?: Buffer }>,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<{ received: true }> {
    const tenantId = this.verifier.tenantFor(provider);
    if (tenantId === undefined) {
      // An unknown provider is recorded nowhere and accepted anyway: telling a
      // caller which provider ids exist is free reconnaissance.
      return { received: true };
    }

    const rawBody = request.rawBody;
    if (rawBody === undefined) {
      // A deployment problem, not a partner problem, and the only case that
      // does not get a 202: accepting a delivery we cannot authenticate and
      // recording it as unverified would bury a misconfiguration in the
      // rejected-traffic count.
      throw new BadRequestException("raw webhook body is required");
    }

    const raw = rawBody.toString("utf8");
    // A body that does not survive a UTF-8 round trip is not the body that was
    // signed, so it cannot be verified against these bytes. The incumbent
    // makes the same check for the same reason.
    if (!Buffer.from(raw, "utf8").equals(rawBody)) {
      throw new BadRequestException("webhook body must be valid UTF-8");
    }

    const verified = this.verifier.verify(provider, raw, headers);
    const shape = this.verifier.interpret(provider, body, headers);

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
