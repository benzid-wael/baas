/**
 * Redact personal data from free text (New-8).
 *
 * The field allow-list in `logging.ts` governs structured payloads. Two things
 * escape it, and both are real:
 *
 * 1. **The message.** `logger.info({...}, `sending OTP to ${mobile}`)` puts the
 *    value in a string before pino sees it. A lint rule now refuses
 *    interpolation in the message position, which is the primary control —
 *    this is the second line.
 * 2. **`err`.** Errors are deliberately exempt from the allow-list, because
 *    filtering them would strip the stack. But an error raised by a *provider*
 *    carries the provider's text, and a bank saying "account AE07…123 not
 *    found" is a bank putting an IBAN in our logs. Nothing in the allow-list
 *    was ever going to catch that.
 *
 * **This is a deny-list, and that is a deliberate exception.** The allow-list
 * is the right shape for fields, whose names we control. It is the wrong shape
 * for free text, where there is no vocabulary to allow. So the rule here is
 * narrower instead: only *named shapes* are redacted — an email, an IBAN, a
 * card number, an international phone number — never anything guessed from
 * entropy or length. A scrubber that eats timestamps and uuids is one people
 * turn off.
 */
export const REDACTED = "[redacted]";

interface Shape {
  readonly name: string;
  readonly pattern: RegExp;
  /** A second test, for shapes a pattern alone cannot identify. */
  readonly only?: (match: string) => boolean;
}

/**
 * A card number, distinguished from any other long run of digits.
 *
 * Luhn alone is not enough: a check digit is one in ten, and the epoch
 * millisecond timestamp `1790500000000` happens to pass. The issuer prefix is
 * what rules it out — no card network begins with 1 — so both tests are
 * applied. Over-redaction is the failure mode that gets a scrubber switched
 * off, so the bar is deliberately high.
 */
export function looksLikeCardNumber(value: string): boolean {
  const digits = value.replace(/[^\d]/g, "");
  return ISSUER_PREFIX.test(digits) && passesLuhn(digits);
}

/** Visa, Mastercard (both series), Amex, Discover, UnionPay, JCB, Diners. */
const ISSUER_PREFIX =
  /^(?:4|5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720)|3[47]|3(?:0[0-5]|[68])|6(?:011|5|4[4-9]|2))/;

/** The check digit every card number carries. */
export function passesLuhn(value: string): boolean {
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const SHAPES: readonly Shape[] = [
  { name: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // Two letters, two check digits, then the basic account number.
  { name: "iban", pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g },
  // 13–19 digits, optionally grouped — **and passing Luhn**. Length alone is
  // not enough: an epoch timestamp in milliseconds is thirteen digits and was
  // being redacted, which is exactly the over-reach that gets a scrubber
  // switched off. Luhn is what actually distinguishes a card number.
  {
    name: "pan",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    only: looksLikeCardNumber,
  },
  // E.164. A bare run of digits is deliberately not matched: that way lies
  // redacting every timestamp and every amount in minor units.
  { name: "msisdn", pattern: /\+\d{7,15}\b/g },
];

export function scrubText(value: string): string {
  let scrubbed = value;
  for (const shape of SHAPES) {
    scrubbed = scrubbed.replace(shape.pattern, (match) =>
      shape.only === undefined || shape.only(match)
        ? `${REDACTED}:${shape.name}`
        : match,
    );
  }
  return scrubbed;
}

/** True when scrubbing would change the text. Used by tests, not by the logger. */
export function containsPersonalData(value: string): boolean {
  return scrubText(value) !== value;
}
