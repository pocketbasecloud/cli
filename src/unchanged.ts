/**
 * Recognising the write that would change nothing.
 *
 * SQLite serialises writers, so the cheapest write is the one never sent: it
 * takes no lock, and it cannot lose a race against one. A surprising number of
 * updates are re-applications of what the instance already stores — a CI job
 * that pushes the same collection definition on every run, a `settings s3 set`
 * repeated from a script, an `update` that changes one field of three. Each
 * still opens a write transaction and still bumps `updated`.
 *
 * The comparison here decides that question conservatively, and every
 * ambiguous case falls open towards writing. A skipped write that should have
 * happened is a silent wrong answer; a write that was not needed only costs
 * what the CLI did before.
 */

/**
 * Deep structural equality, for values that came out of `JSON.parse` — objects,
 * arrays and primitives, with no cycles, dates or class instances to consider.
 *
 * Key order is not significance: `{a,b}` and `{b,a}` are the same stored value.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // NaN never equals itself, and neither does a stored NaN — treat as differing
  // rather than pretending otherwise.
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    // Order matters in an array field: PocketBase stores it as given.
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  if (aKeys.length !== Object.keys(bo).length) return false;
  return aKeys.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

/**
 * Whether applying `patch` to `current` would leave `current` as it is.
 *
 * Only the keys `patch` names are compared — an update is a partial write, and
 * the fields it omits are not part of the question. A key the instance does not
 * report at all (a write-only field like `password`, or one the API masks)
 * reads as "cannot tell", which is a difference, which means the write goes.
 */
export function isNoOpWrite(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): boolean {
  if (!current) return false;
  const keys = Object.keys(patch);
  // An empty body is not something to claim was "already applied"; let the
  // instance answer for it as it did before.
  if (keys.length === 0) return false;
  return keys.every((k) =>
    Object.hasOwn(current, k) && deepEqual(current[k], patch[k])
  );
}
