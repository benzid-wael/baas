import { describe, expect, it } from "vitest";
import {
  REDACTED,
  containsPersonalData,
  looksLikeCardNumber,
  passesLuhn,
  scrubText,
} from "./scrub.js";

describe("shapes that are redacted", () => {
  it.each([
    ["an email", "contact a.person@example.com about it", "email"],
    ["an IBAN", "account AE070331234567890123456 not found", "iban"],
    ["a card number", "card 4111 1111 1111 1111 declined", "pan"],
    ["an unspaced card number", "pan 4111111111111111 declined", "pan"],
    ["an international number", "sent to +971500000000 ok", "msisdn"],
  ])("redacts %s", (_label, text, shape) => {
    const scrubbed = scrubText(text);
    expect(scrubbed).toContain(`${REDACTED}:${shape}`);
    expect(containsPersonalData(text)).toBe(true);
  });

  it("keeps the surrounding words, so the line is still diagnosable", () => {
    expect(scrubText("account AE070331234567890123456 not found")).toBe(
      `account ${REDACTED}:iban not found`,
    );
  });

  it("redacts every occurrence, not just the first", () => {
    const scrubbed = scrubText("from a@b.com to c@d.com");
    expect(scrubbed).toBe(`from ${REDACTED}:email to ${REDACTED}:email`);
  });
});

describe("shapes that are deliberately left alone", () => {
  it.each([
    ["an epoch timestamp", "observed at 1790500000000"],
    ["a long id that is not a card", "reference 12345678901234 seen"],
    ["a uuid", "effect 0192f3a4-5b6c-7d8e-8f90-123456789abc failed"],
    ["minor units", "amount 123450 AED"],
    ["a short reference", "TXN-00421 settled"],
    ["a sort code", "sort code 04-00-75"],
    ["an http status", "provider answered 503"],
  ])("leaves %s intact", (_label, text) => {
    // A scrubber that eats timestamps and uuids is one people turn off. Only
    // named shapes are redacted, never anything guessed from entropy or
    // length.
    expect(scrubText(text)).toBe(text);
    expect(containsPersonalData(text)).toBe(false);
  });
});

describe("a card number is identified by its check digit, not its length", () => {
  it("redacts a number that passes Luhn", () => {
    expect(passesLuhn("4111111111111111")).toBe(true);
    expect(scrubText("card 4111111111111111")).toContain(`${REDACTED}:pan`);
  });

  it("leaves a timestamp alone even though it passes Luhn", () => {
    // A check digit is one in ten, and this particular epoch millisecond
    // value happens to pass. The issuer prefix is what rules it out: no card
    // network begins with 1. Over-redaction is the failure mode that gets a
    // scrubber switched off, so both tests apply.
    expect(passesLuhn("1790500000000")).toBe(true);
    expect(looksLikeCardNumber("1790500000000")).toBe(false);
    expect(scrubText("observed at 1790500000000")).toBe(
      "observed at 1790500000000",
    );
  });

  it.each([
    ["Visa", "4111111111111111"],
    ["Mastercard", "5555555555554444"],
    ["Mastercard 2-series", "2223003122003222"],
    ["Amex", "378282246310005"],
  ])("recognises a %s", (_network, pan) => {
    expect(looksLikeCardNumber(pan)).toBe(true);
  });

  it("rejects anything outside a card's length range", () => {
    expect(passesLuhn("42")).toBe(false);
    expect(passesLuhn("4111111111111111111111")).toBe(false);
  });
});

describe("why this is a deny-list when everything else is an allow-list", () => {
  it("passes text through unchanged when nothing matches", () => {
    // Free text has no vocabulary to allow, so the shape of the control has
    // to be different. The compensation is that the rules are narrow and
    // named rather than heuristic.
    expect(scrubText("dispatch failed for provider keel")).toBe(
      "dispatch failed for provider keel",
    );
  });
});
