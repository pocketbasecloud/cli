// Single source of truth for the CLI version. Bumping a release is a one-line
// edit here — main.ts prints it, and scripts/release.ts stamps all six
// package.json files and the release archives from it.
export const VERSION = "0.6.0";
