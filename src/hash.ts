import { encodeHex } from "@std/encoding/hex";

/**
 * Lowercase SHA-256 hex of `bytes`. Both download paths — the PocketBase
 * binary in `local/install.ts` and `pb` itself in `self/upgrade.ts` — check
 * their archive against a published `checksums.txt`, which lists digests in
 * this form.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return encodeHex(new Uint8Array(digest));
}
