import { globToRegExp, join } from "@std/path";

export const IGNORE_FILE = ".pbcignore";
export const DEFAULT_IGNORE_LINES = ["*.map"];

type Rule = {
  pattern: string;
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean;
  re: RegExp;
};

export class IgnoreRules {
  readonly skipped = new Map<string, number>();

  constructor(private readonly rules: Rule[]) {}

  static parse(lines: string[]): IgnoreRules {
    const rules: Rule[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const negate = line.startsWith("!");
      const body = negate ? line.slice(1) : line;
      const dirOnly = body.endsWith("/");
      const pattern = body.replace(/^\/+|\/+$/g, "");
      if (!pattern) continue;
      const anchored = pattern.includes("/");
      rules.push({
        pattern: line,
        negate,
        dirOnly,
        anchored,
        re: globToRegExp(pattern, { globstar: true, extended: true }),
      });
    }
    return new IgnoreRules(rules);
  }

  match(path: string, isDir: boolean): string | null {
    const name = path.split("/").at(-1) ?? path;
    let matched: Rule | null = null;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(rule.anchored ? path : name)) matched = rule;
    }
    if (!matched || matched.negate) return null;
    this.skipped.set(
      matched.pattern,
      (this.skipped.get(matched.pattern) ?? 0) + 1,
    );
    return matched.pattern;
  }

  summary(): string | null {
    if (this.skipped.size === 0) return null;
    const total = [...this.skipped.values()].reduce((a, b) => a + b, 0);
    const order = (pattern: string) =>
      this.rules.findIndex((rule) => rule.pattern === pattern);
    const parts = [...this.skipped.entries()]
      .sort((a, b) => b[1] - a[1] || order(a[0]) - order(b[0]))
      .map(([pattern, n]) => `${pattern} (${n})`);
    return `Left out ${total} file(s) or folder(s) matched by ${IGNORE_FILE} or its defaults: ${
      parts.join(", ")
    }.`;
  }
}

export async function loadIgnoreRules(cwd: string): Promise<IgnoreRules> {
  const text = await Deno.readTextFile(join(cwd, IGNORE_FILE)).catch(() => "");
  return IgnoreRules.parse([...DEFAULT_IGNORE_LINES, ...text.split(/\r?\n/)]);
}
