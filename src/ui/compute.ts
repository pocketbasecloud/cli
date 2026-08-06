/**
 * How a compute is named to a user.
 *
 * A `servers` record carries an internal name (`pro-compute-3f2a…`) that means
 * nothing outside the platform, so the portal never shows it: dedicated compute
 * is presented as "Compute N — City", numbered oldest-first over the owner's
 * list. The CLI says the same thing about the same machine, because a person
 * comparing the two should not have to work out that they are the same.
 *
 * Mirrors `portal_v2/src/lib/locations.ts` — keep the two in step.
 */

/**
 * The catalog only ever supplies raw datacenter codes (Hetzner's per-type
 * location entries carry no city, OVHcloud's live catalog echoes the code
 * back), so the well-known ones are filled in here.
 */
export const KNOWN_LOCATIONS: Record<string, string> = {
  // Hetzner Cloud
  fsn1: "Falkenstein",
  nbg1: "Nuremberg",
  hel1: "Helsinki",
  ash: "Ashburn, VA",
  hil: "Hillsboro, OR",
  sin: "Singapore",
  // OVHcloud
  GRA: "Gravelines",
  SBG: "Strasbourg",
  RBX: "Roubaix",
  DE: "Frankfurt",
  UK: "London",
  WAW: "Warsaw",
  BHS: "Beauharnois",
  VIN: "Vint Hill, VA",
  SGP: "Singapore",
  SYD: "Sydney",
};

/** A datacenter code with no entry above, made as readable as it can be. */
export function humanizeLocationCode(code: string): string {
  return code
    .split(/[-_]/)
    .map((part) =>
      part.length <= 3
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    )
    .join(" ");
}

export function locationCity(code: string): string {
  return KNOWN_LOCATIONS[code] ?? humanizeLocationCode(code);
}

/**
 * "Compute 2 — Gravelines". `index` is 0-based over the owner's computes
 * ordered oldest-first, which is what keeps the number stable as more are
 * added — and what makes it the same number the portal shows.
 */
export function computeLabel(index: number, location?: string): string {
  const base = `Compute ${index + 1}`;
  return location ? `${base} — ${locationCity(location)}` : base;
}
