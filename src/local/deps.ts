/**
 * Side effects the local-binary commands need, injected so every unit test can
 * run without touching the network or the real filesystem.
 */
export type LocalDeps = {
  fetch: typeof fetch;
  cwd: () => string;
  readTextFile: (p: string) => Promise<string>;
  writeFile: (p: string, d: Uint8Array) => Promise<void>;
  writeTextFile: (p: string, d: string) => Promise<void>;
  mkdir: (p: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  chmod: (p: string, mode: number) => Promise<void>;
  /** Resolves to null when the path does not exist. */
  stat: (p: string) => Promise<{ isFile: boolean } | null>;
  remove: (p: string) => Promise<void>;
  env: (k: string) => string | undefined;
};
