// Unit tests for src/lib/nonce.ts (Feature s5-feat-002).
//
// nonce.ts provides the transcription nonce gate for `ghs-force-archive`:
//   - generateNonce()           -> random 8-char alphanumeric string
//   - verifyTranscribeNonce()   -> case-insensitive, whitespace-trimmed compare
//
// nonce.ts is a net-new TS module (the source Claude Code plugin gates
// archive behind a transcription prompt; we port the gate to TS), so these
// are pure behavioural tests. Coverage map (acceptance_criteria #1):
//   - nonce generation .......... describe("generateNonce")
//   - expected length/format ..... describe("generateNonce - shape")
//   - repeat-call uniqueness ..... describe("generateNonce - uniqueness")
//   - transcription verify ....... describe("verifyTranscribeNonce")
//
// Style follows test/state.test.ts (s3-feat-005) / test/parallel-utils.test.ts
// (s4-feat-002): bun:test describe/test/expect, no real `.ghs/` dependency,
// deterministic assertions. For the uniqueness check we draw a large enough
// sample that a birthday collision on the 62-symbol alphabet is astronomically
// unlikely but still cheap to generate.

import { expect, test, describe } from "bun:test";

import { generateNonce, verifyTranscribeNonce } from "../src/lib/nonce";

// =============================================================================
// generateNonce — generation + shape
// =============================================================================

describe("generateNonce - shape (s5-feat-002)", () => {
  test("(a) returns a string", () => {
    expect(typeof generateNonce()).toBe("string");
  });

  test("(b) length is exactly 8 characters", () => {
    const nonce = generateNonce();
    expect(nonce.length).toBe(8);
  });

  test("(c) every character is alphanumeric [A-Za-z0-9]", () => {
    const ALPHABET = /^[A-Za-z0-9]+$/;
    // Sample several draws so a one-off glitch can't slip through.
    for (let i = 0; i < 50; i++) {
      expect(generateNonce()).toMatch(ALPHABET);
    }
  });

  test("(d) contains no whitespace, punctuation, or symbols", () => {
    const nonce = generateNonce();
    expect(/\s/.test(nonce)).toBe(false);
    expect(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(nonce)).toBe(false);
  });
});

// =============================================================================
// generateNonce — uniqueness / randomness
// =============================================================================

describe("generateNonce - uniqueness (s5-feat-002)", () => {
  test("(a) two consecutive calls produce different nonces", () => {
    // Not a strict guarantee of a CSPRNG, but two draws in a row being equal
    // would be a catastrophic failure of the entropy source.
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
  });

  test("(b) a sample of 1000 draws are all unique", () => {
    // The 62-symbol alphabet at length 8 has ~218 trillion combinations.
    // 1000 draws should never collide; a collision here would indicate the
    // generator is deterministic or re-seeded to a fixed state.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateNonce());
    }
    expect(seen.size).toBe(1000);
  });

  test("(c) draws cover at least two distinct alphabets over a large sample", () => {
    // A well-distributed generator will use both letters and digits. We don't
    // assert exact distribution (that would be flaky) — just that the output
    // isn't stuck in a single character class over 200 draws.
    const chars = new Set<string>();
    for (let i = 0; i < 200; i++) {
      for (const c of generateNonce()) chars.add(c);
    }
    const hasLetter = /[A-Za-z]/.test([...chars].join(""));
    const hasDigit = /[0-9]/.test([...chars].join(""));
    expect(hasLetter && hasDigit).toBe(true);
  });
});

// =============================================================================
// verifyTranscribeNonce
// =============================================================================

describe("verifyTranscribeNonce (s5-feat-002)", () => {
  test("(a) exact match returns true", () => {
    const nonce = generateNonce();
    expect(verifyTranscribeNonce(nonce, nonce)).toBe(true);
  });

  test("(b) case-insensitive match returns true", () => {
    expect(verifyTranscribeNonce("AbC123xY", "abc123Xy")).toBe(true);
  });

  test("(c) leading/trailing whitespace on the transcription is trimmed", () => {
    const nonce = "abcd1234";
    expect(verifyTranscribeNonce(nonce, "   abcd1234   ")).toBe(true);
  });

  test("(d) leading/trailing whitespace on the nonce is trimmed too", () => {
    const nonce = "  abcd1234  ";
    expect(verifyTranscribeNonce(nonce, "abcd1234")).toBe(true);
  });

  test("(e) a mismatched transcription returns false", () => {
    expect(verifyTranscribeNonce("abcd1234", "abcd1235")).toBe(false);
  });

  test("(f) a careless 'yes' / 'confirmed' never matches a real nonce", () => {
    // The whole point of the gate — these must never accidentally pass.
    const nonce = generateNonce();
    expect(verifyTranscribeNonce(nonce, "yes")).toBe(false);
    expect(verifyTranscribeNonce(nonce, "confirmed")).toBe(false);
    expect(verifyTranscribeNonce(nonce, "ok")).toBe(false);
  });

  test("(g) internal whitespace is preserved (not collapsed)", () => {
    // "ab cd1234" != "abcd1234" — only leading/trailing trim, per spec.
    expect(verifyTranscribeNonce("abcd1234", "ab cd1234")).toBe(false);
  });

  test("(h) an empty transcription returns false", () => {
    expect(verifyTranscribeNonce("abcd1234", "")).toBe(false);
    expect(verifyTranscribeNonce("abcd1234", "   ")).toBe(false);
  });

  test("(i) an empty nonce returns false", () => {
    expect(verifyTranscribeNonce("", "abcd1234")).toBe(false);
    expect(verifyTranscribeNonce("   ", "abcd1234")).toBe(false);
  });

  test("(j) non-string inputs return false (type guard)", () => {
    expect(
      verifyTranscribeNonce(undefined as unknown as string, "abcd1234"),
    ).toBe(false);
    expect(
      verifyTranscribeNonce("abcd1234", null as unknown as string),
    ).toBe(false);
    expect(
      verifyTranscribeNonce(
        12345678 as unknown as string,
        "abcd1234" as unknown as string,
      ),
    ).toBe(false);
  });

  test("(k) round-trips a freshly generated nonce", () => {
    const nonce = generateNonce();
    // User types it back verbatim -> accepted.
    expect(verifyTranscribeNonce(nonce, nonce)).toBe(true);
    // User types a single wrong char -> rejected.
    const wrong = nonce.slice(0, -1) + (nonce.endsWith("0") ? "1" : "0");
    expect(verifyTranscribeNonce(nonce, wrong)).toBe(false);
  });
});
