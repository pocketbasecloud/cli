/**
 * Platform limits the CLI has to know about before it makes a call.
 *
 * This lives on its own so both the deploy path (which checks the archive
 * ahead of the upload) and the API client (which has to explain a 413 after
 * one) can read the same number without importing each other.
 */

/**
 * Largest archive the platform accepts.
 *
 * Three layers can reject an upload and this number is real only when all
 * three allow it: Cloudflare (100 MB, not configurable — the API hostname is
 * proxied off so it does not apply), Caddy's `request_body max_size` on the
 * backend host, and the `zipFile` maxSize on `pocketbases` / `frontends` /
 * `backends`. The two we control are set above this number because they
 * measure the whole multipart body, not the file.
 *
 * See `portal_v2/src/lib/uploadLimits.ts` — the portal's copy of this, with
 * the full table. Changing one without the other is what let the clients
 * advertise 150 MB for months while the platform accepted 100 MB.
 */
export const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024;

/** The limit in whole megabytes, for a message. */
export const MAX_ARCHIVE_MB = Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024);
