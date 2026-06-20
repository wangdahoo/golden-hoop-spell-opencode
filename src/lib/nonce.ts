// Transcription nonce gate for `ghs-force-archive`.
//
// `ghs-force-archive` archives ALL sprints regardless of status — destructive.
// The source Claude Code plugin (see
// `plugin/skills/ghs-force-archive/SKILL.md`) gates the archive behind an
// explicit user confirmation: the agent shows the nonce and asks the user to
// transcribe it back before proceeding. We replicate that gate here.
//
// Comparison semantics (must match the source behaviour):
//   - Case-insensitive: `AbC123` matches `abc123`.
//   - Whitespace-trimmed: leading/trailing whitespace on either side is
//     stripped before comparison. Internal whitespace is preserved.
//
// The nonce is a random alphanumeric string — short enough to transcribe,
// long enough that a careless "yes" / "confirmed" won't accidentally match.

const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const NONCE_LENGTH = 8;

/**
 * Generate a random alphanumeric nonce suitable for transcription comparison.
 *
 * Uses `crypto.getRandomValues` for cryptographic randomness. The result is
 * 8 characters drawn from `[A-Za-z0-9]`.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(NONCE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < NONCE_LENGTH; i++) {
    out += NONCE_ALPHABET[bytes[i] % NONCE_ALPHABET.length];
  }
  return out;
}

/**
 * Verify that a user-supplied transcription matches the issued nonce.
 *
 * Comparison is case-insensitive and trims leading/trailing whitespace on
 * both inputs before comparing. Returns `true` only if the normalised forms
 * are byte-identical.
 *
 * @param nonce        - the nonce originally issued by `generateNonce()`.
 * @param transcription - the string the user typed back.
 */
export function verifyTranscribeNonce(nonce: string, transcription: string): boolean {
  if (typeof nonce !== "string" || typeof transcription !== "string") {
    return false;
  }
  const a = nonce.trim().toLowerCase();
  const b = transcription.trim().toLowerCase();
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  return a === b;
}
