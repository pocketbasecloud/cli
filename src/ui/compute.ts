export const KNOWN_LOCATIONS: Record<string, string> = {
  fsn1: "Falkenstein",
  nbg1: "Nuremberg",
  hel1: "Helsinki",
  ash: "Ashburn, VA",
  hil: "Hillsboro, OR",
  sin: "Singapore",
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
  SGN: "Ho Chi Minh City",
  "vn-han": "Hanoi",
  "vn-sgn": "Ho Chi Minh City",
  "vn-dad": "Da Nang",
  "jp-tyo": "Japan",
  "in-bom": "India",
  "us-central": "US Central",
  "us-east": "US East",
  "us-west": "US West",
};

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

export function computeLabel(
  index: number,
  location?: string,
  shortKey?: string,
): string {
  const base = `Compute ${index + 1}`;
  const withLocation = location ? `${base} — ${locationCity(location)}` : base;
  return shortKey ? `${withLocation} (${shortKey})` : withLocation;
}
