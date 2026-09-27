import { BadRequestException, Catch } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Inbox } from "@baas/persistence";
import type { WebhookVerifier } from "@baas/domain";
import type { Logger } from "@baas/platform";
import { describeError } from "@baas/platform";

/**
 * A malformed callback body is still a delivery (New-22).
 *
 * The global JSON parser rejects an unparseable body **before routing**, so
 * `WebhookController` never sees it. Until this filter existed that meant two
 * things, and the second is the sharper one:
 *
 * 1. **The delivery vanished.** "Record, do not process" is the whole design
 *    of the inbox (finding C2), and a partner sending garbage is exactly the
 *    evidence worth keeping — it is how a broken integration is told apart
 *    from a quiet one.
 * 2. **The 400 echoed the body back**: `Unexpected token 't', "this is not
 *    json" is not valid JSON`. An unverified caller got a fragment of its own
 *    input reflected, and a partner's malformed payload could carry personal
 *    data into an error response and whatever logs it.
 *
 * A filter rather than different middleware, deliberately. The alternative was
 * mounting `express.raw` ahead of Nest's parsers, which changes what populates
 * the body and therefore risks the raw-body capture that signature
 * verification depends on. This leaves the parser stack untouched: the
 * parser's `verify` hook has already run by the time it throws, so
 * `request.rawBody` holds the bytes the partner actually sent.
 */
interface ParsedRequest {
  readonly url?: string;
  readonly method?: string;
  readonly rawBody?: Buffer;
  readonly headers?: Record<string, string | undefined>;
}

interface Responder {
  status(code: number): { json(body: unknown): void };
}

/** `POST /webhooks/<provider>`, and nothing else. */
const WEBHOOK_PATH = /^\/webhooks\/([^/?#]+)\/?(?:[?#]|$)/;

@Catch(BadRequestException)
export class WebhookBodyFilter implements ExceptionFilter {
  constructor(
    private readonly inbox: Inbox,
    private readonly verifier: WebhookVerifier,
    private readonly logger: Logger,
  ) {}

  async catch(
    exception: BadRequestException,
    host: ArgumentsHost,
  ): Promise<void> {
    const http = host.switchToHttp();
    const request = http.getRequest<ParsedRequest>();
    const response = http.getResponse<Responder>();

    const provider = this.webhookProvider(request);
    if (provider === undefined) {
      // Not ours. Reproduce the default filter's response exactly rather than
      // rethrowing — a throw from inside a filter becomes a 500, and this must
      // not change what any other route returns.
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    const tenantId = this.verifier.tenantFor(provider);
    // Always 202, and never a word about the body. The parser's message quotes
    // the input; this one says nothing a caller did not already know.
    const reply = (): void => {
      response.status(202).json({ received: true });
    };

    if (tenantId === undefined || request.rawBody === undefined) {
      reply();
      return;
    }

    const raw = request.rawBody.toString("utf8");
    const headers = request.headers ?? {};

    try {
      await this.inbox.record({
        tenantId,
        providerId: provider,
        // The body did not parse, so there is nothing to read an id out of.
        // A header-borne id is still usable, and for Keel that is the
        // contractual one anyway.
        ...this.verifier.interpret(provider, undefined, headers),
        // Verified against the bytes, which is the only thing verification
        // ever looked at. A correctly signed delivery that happens to be
        // malformed is signed by the partner, and saying otherwise would be
        // wrong.
        signatureVerified: this.verifier.verify(provider, raw, headers),
        payload: { unparseable: raw },
      });
    } catch (error) {
      // The delivery is lost either way at this point; say so loudly rather
      // than answering 202 to something that was never written down.
      this.logger.error(
        { providerId: provider, err: describeError(error) },
        "could not record an unparseable callback",
      );
    }

    reply();
  }

  private webhookProvider(request: ParsedRequest): string | undefined {
    if (request.method !== "POST") {
      return undefined;
    }
    return WEBHOOK_PATH.exec(request.url ?? "")?.[1];
  }
}
