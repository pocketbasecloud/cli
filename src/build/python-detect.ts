export const PYTHON_VERSIONS = [
  "3.10",
  "3.11",
  "3.12",
  "3.13",
  "3.14",
] as const;
export type PythonVersion = (typeof PYTHON_VERSIONS)[number];
export const DEFAULT_PYTHON_VERSION: PythonVersion = "3.12";

export const PYTHON_MANIFESTS = [
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
];

export type PythonFramework =
  | "django"
  | "flask"
  | "fastapi"
  | "starlette"
  | "litestar"
  | "quart"
  | "sanic"
  | "bottle"
  | "falcon"
  | "streamlit"
  | "gradio"
  | "dash"
  | "celery"
  | "script";

export interface PythonStart {
  framework?: PythonFramework;
  startCommand?: string;
}

export class UnsupportedPythonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPythonError";
  }
}

export function isPythonVersion(value: unknown): value is PythonVersion {
  return typeof value === "string" &&
    (PYTHON_VERSIONS as readonly string[]).includes(value);
}

const VERSION_FILES = [".python-version", "runtime.txt"];
const PACKAGE_ENTRY_FILES = [
  "main.py",
  "app.py",
  "__init__.py",
  "wsgi.py",
  "asgi.py",
  "server.py",
  "api.py",
];
const APP_FILE_PRIORITY = [
  "main.py",
  "app.py",
  "application.py",
  "server.py",
  "api.py",
  "wsgi.py",
  "asgi.py",
  "run.py",
];
const SCRIPT_PRIORITY = [
  "main.py",
  "app.py",
  "server.py",
  "bot.py",
  "run.py",
  "worker.py",
];
const STREAMLIT_PRIORITY = ["streamlit_app.py", "app.py", "main.py", "Home.py"];
const MAX_SCANNED_FILES = 40;
const IDENTIFIER = /^[A-Za-z_]\w*$/;

function isRootFile(path: string): boolean {
  return !path.includes("/");
}

function isRootScript(path: string): boolean {
  return isRootFile(path) && path.endsWith(".py");
}

function isPackageEntry(path: string): boolean {
  const parts = path.split("/");
  return parts.length === 2 && IDENTIFIER.test(parts[0]) &&
    PACKAGE_ENTRY_FILES.includes(parts[1]);
}

function isRequirementsFile(path: string): boolean {
  return (isRootFile(path) && /^requirements.*\.txt$/.test(path)) ||
    /^requirements\/[^/]+\.txt$/.test(path);
}

export function hasPythonManifest(paths: string[]): boolean {
  return paths.some((path) => PYTHON_MANIFESTS.includes(path));
}

export function isPythonProject(paths: string[]): boolean {
  return hasPythonManifest(paths) || paths.some(isRootScript);
}

export function pythonFilesToRead(paths: string[]): string[] {
  const wanted = paths.filter((path) =>
    VERSION_FILES.includes(path) || path === "pyproject.toml" ||
    path === "Pipfile" || path === "manage.py" || path === "Procfile" ||
    isRequirementsFile(path)
  );
  const scripts = paths.filter(isRootScript).slice(0, MAX_SCANNED_FILES);
  const packages = paths.filter(isPackageEntry).slice(0, MAX_SCANNED_FILES);
  return [...new Set([...wanted, ...scripts, ...packages])];
}

type Dependencies = Map<string, Set<string>>;

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

const REQUIREMENT = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?/;

function addRequirement(deps: Dependencies, spec: string): void {
  const match = REQUIREMENT.exec(spec);
  if (!match) return;
  const name = normalizeName(match[1]);
  const extras = deps.get(name) ?? new Set<string>();
  for (const extra of (match[2] ?? "").split(",")) {
    if (extra.trim()) extras.add(normalizeName(extra.trim()));
  }
  deps.set(name, extras);
}

function readRequirements(text: string, deps: Dependencies): void {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue;
    addRequirement(deps, line);
  }
}

function withoutQuoted(line: string): string {
  return line.replace(/"[^"]*"|'[^']*'/g, "");
}

function isInstalledTable(section: string): boolean {
  return section === "packages" || section === "tool.poetry.dependencies";
}

function readTomlDependencies(text: string, deps: Dependencies): void {
  let section = "";
  let inDependencyArray = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      section = header[1].trim();
      inDependencyArray = false;
      continue;
    }
    if (inDependencyArray) {
      for (const quoted of line.matchAll(/"([^"]+)"|'([^']+)'/g)) {
        addRequirement(deps, quoted[1] ?? quoted[2]);
      }
      if (withoutQuoted(line).includes("]")) inDependencyArray = false;
      continue;
    }
    if (section === "project" && /^dependencies\s*=\s*\[/.test(line)) {
      const rest = line.slice(line.indexOf("[") + 1);
      for (const quoted of rest.matchAll(/"([^"]+)"|'([^']+)'/g)) {
        addRequirement(deps, quoted[1] ?? quoted[2]);
      }
      inDependencyArray = !withoutQuoted(rest).includes("]");
      continue;
    }
    if (isInstalledTable(section)) {
      const key = /^"?([A-Za-z0-9][A-Za-z0-9._-]*)"?\s*=/.exec(line)?.[1];
      if (key && normalizeName(key) !== "python") {
        const extras = /extras\s*=\s*\[([^\]]*)\]/.exec(line)?.[1];
        const names = extras ? extras.replace(/["'\s]/g, "") : "";
        addRequirement(deps, names ? `${key}[${names}]` : key);
      }
    }
  }
}

function readDependencies(texts: Record<string, string>): Dependencies {
  const deps: Dependencies = new Map();
  for (const [path, text] of Object.entries(texts)) {
    if (isRequirementsFile(path)) readRequirements(text, deps);
  }
  if (texts["pyproject.toml"]) {
    readTomlDependencies(texts["pyproject.toml"], deps);
  }
  if (texts["Pipfile"]) readTomlDependencies(texts["Pipfile"], deps);
  return deps;
}

function hasExtra(deps: Dependencies, name: string, extra: string): boolean {
  return deps.get(name)?.has(extra) ?? false;
}

function moduleOf(path: string): string {
  const withoutExt = path.replace(/\.py$/, "");
  return withoutExt.endsWith("/__init__")
    ? withoutExt.slice(0, -"/__init__".length).replaceAll("/", ".")
    : withoutExt.replaceAll("/", ".");
}

function byPriority(paths: string[], priority: string[]): string[] {
  const rank = (path: string) => {
    const index = priority.indexOf(path);
    return index === -1 ? priority.length : index;
  };
  return [...paths].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function appFileOrder(paths: string[]): string[] {
  const roots = byPriority(paths.filter(isRootScript), APP_FILE_PRIORITY);
  const packages = paths.filter(isPackageEntry).sort((a, b) => {
    const aApp = a.startsWith("app/") ? 0 : 1;
    const bApp = b.startsWith("app/") ? 0 : 1;
    return aApp - bApp ||
      PACKAGE_ENTRY_FILES.indexOf(a.split("/")[1]) -
        PACKAGE_ENTRY_FILES.indexOf(b.split("/")[1]) ||
      a.localeCompare(b);
  });
  return [...roots, ...packages];
}

type AppKind = "asgi" | "wsgi" | "sanic" | "dash" | "celery";

const APP_CONSTRUCTORS: ReadonlyArray<
  readonly [PythonFramework, AppKind, string]
> = [
  ["fastapi", "asgi", String.raw`(?:[\w.]*\.)?FastAPI`],
  ["starlette", "asgi", String.raw`(?:[\w.]*\.)?Starlette`],
  ["litestar", "asgi", String.raw`(?:[\w.]*\.)?Litestar`],
  ["quart", "asgi", String.raw`(?:[\w.]*\.)?Quart`],
  ["falcon", "asgi", String.raw`falcon\.asgi\.App`],
  ["sanic", "sanic", String.raw`(?:[\w.]*\.)?Sanic`],
  ["flask", "wsgi", String.raw`(?:[\w.]*\.)?Flask`],
  ["bottle", "wsgi", String.raw`(?:[\w.]*\.)?Bottle`],
  ["falcon", "wsgi", String.raw`falcon\.(?:App|API)`],
  ["dash", "dash", String.raw`(?:[\w.]*\.)?Dash`],
  ["celery", "celery", String.raw`(?:[\w.]*\.)?Celery`],
];

const FACTORY_FRAMEWORKS: ReadonlyArray<
  readonly [PythonFramework, AppKind, RegExp]
> = [
  ["quart", "asgi", /^\s*(?:from\s+quart\s+import|import\s+quart)\b/m],
  ["fastapi", "asgi", /^\s*(?:from\s+fastapi\s+import|import\s+fastapi)\b/m],
  ["flask", "wsgi", /^\s*(?:from\s+flask\s+import|import\s+flask)\b/m],
];

interface AppTarget {
  framework: PythonFramework;
  kind: AppKind;
  file: string;
  module: string;
  object: string;
  factory: boolean;
  text: string;
}

function assignedObject(text: string, constructor: string): string | undefined {
  const pattern = new RegExp(
    String.raw`^([A-Za-z_]\w*)\s*(?::[^=\n]*)?=\s*${constructor}\s*\(`,
    "m",
  );
  return pattern.exec(text)?.[1];
}

function frameworkFromDependencies(
  deps: Dependencies,
): readonly [PythonFramework, AppKind] | undefined {
  for (const [framework, kind] of FACTORY_FRAMEWORKS) {
    if (deps.has(framework)) return [framework, kind];
  }
  return undefined;
}

function findAppTarget(
  paths: string[],
  texts: Record<string, string>,
  deps: Dependencies,
): AppTarget | undefined {
  const files = appFileOrder(paths).filter((path) => texts[path]);
  for (const file of files) {
    const text = texts[file];
    for (const [framework, kind, constructor] of APP_CONSTRUCTORS) {
      const object = assignedObject(text, constructor);
      if (object) {
        return {
          framework,
          kind,
          file,
          module: moduleOf(file),
          object,
          factory: false,
          text,
        };
      }
    }
  }
  for (const file of files) {
    const text = texts[file];
    const created = /^([A-Za-z_]\w*)\s*=\s*(?:create_app|make_app)\s*\(/m
      .exec(text)?.[1];
    const factory = /^(?:async\s+)?def\s+(create_app|make_app)\s*\(/m
      .exec(text)?.[1];
    const object = created ?? factory;
    if (!object) continue;
    const imported = FACTORY_FRAMEWORKS.find(([, , imports]) =>
      imports.test(text)
    );
    const framework = imported
      ? [imported[0], imported[1]] as const
      : frameworkFromDependencies(deps);
    if (!framework) continue;
    return {
      framework: framework[0],
      kind: framework[1],
      file,
      module: moduleOf(file),
      object,
      factory: !created,
      text,
    };
  }
  return undefined;
}

function runsItselfOnPort(text: string): boolean {
  return /if\s+__name__\s*==\s*["']__main__["']/.test(text) &&
    /environ(?:\.get)?\s*[([]\s*["']PORT["']|getenv\s*\(\s*["']PORT["']/
      .test(text);
}

const HOST_PORT = "--host 0.0.0.0 --port $PORT";

function asgiCommand(target: AppTarget, deps: Dependencies): string {
  const ref = `${target.module}:${target.object}`;
  const hasUvicorn = deps.has("uvicorn") ||
    hasExtra(deps, "fastapi", "standard") ||
    hasExtra(deps, "litestar", "standard") ||
    hasExtra(deps, "starlette", "full");
  if (hasUvicorn) {
    return target.factory
      ? `uvicorn --factory ${ref} ${HOST_PORT}`
      : `uvicorn ${ref} ${HOST_PORT}`;
  }
  if (deps.has("hypercorn")) {
    return `hypercorn "${ref}${
      target.factory ? "()" : ""
    }" --bind 0.0.0.0:$PORT`;
  }
  if (deps.has("granian")) {
    return `granian --interface asgi ${
      target.factory ? "--factory " : ""
    }${HOST_PORT} ${ref}`;
  }
  if (runsItselfOnPort(target.text)) return `python ${target.file}`;
  if (target.framework === "quart") {
    return `quart --app ${appRef(target)} run ${HOST_PORT}`;
  }
  if (target.framework === "litestar" && !target.factory) {
    return `litestar --app ${ref} run ${HOST_PORT}`;
  }
  return target.factory
    ? `uvicorn --factory ${ref} ${HOST_PORT}`
    : `uvicorn ${ref} ${HOST_PORT}`;
}

function appRef(target: AppTarget): string {
  if (target.factory || target.object === "app") return target.module;
  return `${target.module}:${target.object}`;
}

function wsgiCommand(target: AppTarget, deps: Dependencies): string {
  const ref = `${target.module}:${target.object}`;
  if (deps.has("gunicorn")) {
    return target.factory
      ? `gunicorn "${ref}()" --bind 0.0.0.0:$PORT`
      : `gunicorn ${ref} --bind 0.0.0.0:$PORT`;
  }
  if (deps.has("waitress")) {
    return target.factory
      ? `waitress-serve --listen=0.0.0.0:$PORT --call ${ref}`
      : `waitress-serve --listen=0.0.0.0:$PORT ${ref}`;
  }
  if (runsItselfOnPort(target.text)) return `python ${target.file}`;
  if (target.framework === "flask") {
    return `flask --app ${appRef(target)} run ${HOST_PORT}`;
  }
  return `python ${target.file}`;
}

function dashCommand(target: AppTarget, deps: Dependencies): string {
  const server = new RegExp(
    String.raw`^([A-Za-z_]\w*)\s*=\s*${target.object}\.server\b`,
    "m",
  ).exec(target.text)?.[1];
  if (server && deps.has("gunicorn")) {
    return `gunicorn ${target.module}:${server} --bind 0.0.0.0:$PORT`;
  }
  return `env HOST=0.0.0.0 python ${target.file}`;
}

function sanicCommand(target: AppTarget): string {
  const ref = `${target.module}:${target.object}`;
  return target.factory
    ? `sanic ${ref} --factory ${HOST_PORT}`
    : `sanic ${ref} ${HOST_PORT}`;
}

function djangoPackage(
  paths: string[],
  texts: Record<string, string>,
): string | undefined {
  const settings = /DJANGO_SETTINGS_MODULE["']\s*,\s*["']([\w.]+)["']/
    .exec(texts["manage.py"] ?? "")?.[1];
  const fromSettings = settings?.split(".settings")[0];
  if (
    fromSettings &&
    paths.includes(`${fromSettings.replaceAll(".", "/")}/wsgi.py`)
  ) {
    return fromSettings;
  }
  const wsgi = paths.find((path) =>
    /^[A-Za-z_]\w*\/wsgi\.py$/.test(path) &&
    paths.includes(path.replace(/wsgi\.py$/, "settings.py"))
  ) ?? paths.find((path) => /^[A-Za-z_]\w*\/wsgi\.py$/.test(path));
  return wsgi?.split("/")[0] ?? fromSettings;
}

function djangoCommand(
  paths: string[],
  texts: Record<string, string>,
  deps: Dependencies,
): string {
  const pkg = djangoPackage(paths, texts);
  if (
    pkg && deps.has("gunicorn") &&
    paths.includes(`${pkg.replaceAll(".", "/")}/wsgi.py`)
  ) {
    return `gunicorn ${pkg}.wsgi --bind 0.0.0.0:$PORT`;
  }
  if (
    pkg && deps.has("uvicorn") &&
    paths.includes(`${pkg.replaceAll(".", "/")}/asgi.py`)
  ) {
    return `uvicorn ${pkg}.asgi:application ${HOST_PORT}`;
  }
  return "python manage.py runserver 0.0.0.0:$PORT --noreload";
}

const IMPORTS_STREAMLIT = /^\s*(?:import\s+streamlit|from\s+streamlit\b)/m;
const IMPORTS_GRADIO = /^\s*(?:import\s+gradio|from\s+gradio\b)/m;

function rootScriptImporting(
  paths: string[],
  texts: Record<string, string>,
  pattern: RegExp,
  priority: string[],
): string | undefined {
  return byPriority(paths.filter(isRootScript), priority).find((path) =>
    pattern.test(texts[path] ?? "")
  );
}

function scriptEntry(paths: string[]): string | undefined {
  const scripts = paths.filter(isRootScript);
  const preferred = SCRIPT_PRIORITY.find((name) => scripts.includes(name));
  if (preferred) return preferred;
  return scripts.length === 1 ? scripts[0] : undefined;
}

export function inferPythonStart(
  paths: string[],
  texts: Record<string, string>,
): PythonStart {
  const detected = inferFrameworkStart(paths, texts);
  const procfile = procfileWebCommand(texts["Procfile"]);
  return procfile ? { ...detected, startCommand: procfile } : detected;
}

function procfileWebCommand(text: string | undefined): string | undefined {
  const command = text && /^web:\s*(.+?)\s*$/m.exec(text)?.[1];
  return command || undefined;
}

function inferFrameworkStart(
  paths: string[],
  texts: Record<string, string>,
): PythonStart {
  const deps = readDependencies(texts);

  if (paths.includes("manage.py")) {
    return {
      framework: "django",
      startCommand: djangoCommand(paths, texts, deps),
    };
  }

  const target = findAppTarget(paths, texts, deps);
  if (target) {
    const startCommand = target.kind === "asgi"
      ? asgiCommand(target, deps)
      : target.kind === "sanic"
      ? sanicCommand(target)
      : target.kind === "dash"
      ? dashCommand(target, deps)
      : target.kind === "celery"
      ? `celery -A ${target.module} worker --loglevel=info`
      : wsgiCommand(target, deps);
    return { framework: target.framework, startCommand };
  }

  const streamlit = rootScriptImporting(
    paths,
    texts,
    IMPORTS_STREAMLIT,
    STREAMLIT_PRIORITY,
  );
  if (streamlit) {
    return {
      framework: "streamlit",
      startCommand: `streamlit run ${streamlit} --server.address 0.0.0.0 ` +
        "--server.port $PORT --server.headless true",
    };
  }

  const gradio = rootScriptImporting(
    paths,
    texts,
    IMPORTS_GRADIO,
    SCRIPT_PRIORITY,
  );
  if (gradio) {
    return {
      framework: "gradio",
      startCommand:
        `env GRADIO_SERVER_NAME=0.0.0.0 GRADIO_SERVER_PORT=$PORT python ${gradio}`,
    };
  }

  const entry = scriptEntry(paths);
  return entry ? { framework: "script", startCommand: `python ${entry}` } : {};
}

type Version = number[];

function compareMinor(minor: number, version: Version): number {
  const [major, versionMinor = 0] = version;
  if (major !== 3) return 3 - major;
  return minor - versionMinor;
}

function clauseAllows(
  operator: string,
  version: Version,
  wildcard: boolean,
  minor: number,
): boolean {
  const cmp = compareMinor(minor, version);
  const patch = version[2] ?? 0;
  switch (operator) {
    case ">=":
    case ">":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0 || (cmp === 0 && version.length >= 3 && patch > 0);
    case "==":
    case "===":
      return version.length === 1 ? version[0] === 3 : cmp === 0;
    case "!=":
      if (!wildcard) return true;
      return version.length === 1 ? version[0] !== 3 : cmp !== 0;
    case "~=":
      return version.length >= 3 ? cmp === 0 : version[0] === 3 && cmp >= 0;
    default:
      return true;
  }
}

const CLAUSE = /^(===|==|!=|~=|>=|<=|>|<)?\s*v?(\d+(?:\.\d+)*)(\.\*)?$/;

function pepAllows(specifier: string, minor: number): boolean | undefined {
  const clauses = specifier.split(",").map((c) => c.trim()).filter(Boolean);
  if (clauses.length === 0) return undefined;
  for (const clause of clauses) {
    const match = CLAUSE.exec(clause);
    if (!match) return undefined;
    const version = match[2].split(".").map(Number);
    if (!clauseAllows(match[1] ?? "==", version, !!match[3], minor)) {
      return false;
    }
  }
  return true;
}

function poetryClauseToPep(clause: string): string {
  const caret = /^\^\s*(\d+)(?:\.(\d+))?/.exec(clause);
  if (caret) {
    return `>=${caret[1]}.${caret[2] ?? 0},<${Number(caret[1]) + 1}`;
  }
  const tilde = /^~(?!=)\s*(\d+)\.(\d+)/.exec(clause);
  if (tilde) {
    return `>=${tilde[1]}.${tilde[2]},<${tilde[1]}.${Number(tilde[2]) + 1}`;
  }
  if (/^\d+(?:\.\d+)*(?:\.\*)?$/.test(clause)) return `==${clause}`;
  return clause;
}

function poetryAllows(constraint: string, minor: number): boolean | undefined {
  const alternatives = constraint.split("||").map((a) => a.trim());
  let any: boolean | undefined;
  for (const alternative of alternatives) {
    const pep = alternative.split(/\s*,\s*|\s+(?=[<>=!~^])/).map((c) =>
      poetryClauseToPep(c.trim())
    ).join(",");
    const allowed = pepAllows(pep, minor);
    if (allowed === undefined) return undefined;
    any = (any ?? false) || allowed;
  }
  return any;
}

function minorOf(version: PythonVersion): number {
  return Number(version.split(".")[1]);
}

function supportedRange(): string {
  return `${PYTHON_VERSIONS[0]}–${PYTHON_VERSIONS[PYTHON_VERSIONS.length - 1]}`;
}

function pickAllowed(
  source: string,
  specifier: string,
  allows: (minor: number) => boolean | undefined,
): PythonVersion | undefined {
  const verdicts = PYTHON_VERSIONS.map((v) => [v, allows(minorOf(v))] as const);
  if (verdicts.some(([, allowed]) => allowed === undefined)) return undefined;
  const allowed = verdicts.filter(([, ok]) => ok).map(([v]) => v);
  if (allowed.length === 0) {
    throw new UnsupportedPythonError(
      `${source} requires Python "${specifier}", which excludes every ` +
        `version the platform runs (${supportedRange()}).`,
    );
  }
  if (allowed.includes(DEFAULT_PYTHON_VERSION)) return DEFAULT_PYTHON_VERSION;
  const target = minorOf(DEFAULT_PYTHON_VERSION);
  return [...allowed].sort((a, b) =>
    Math.abs(minorOf(a) - target) - Math.abs(minorOf(b) - target) ||
    minorOf(a) - minorOf(b)
  )[0];
}

function pinned(source: string, major: number, minor: number): PythonVersion {
  const version = `${major}.${minor}`;
  if (isPythonVersion(version)) return version;
  const reason = major < 3
    ? "Python 2 is not supported"
    : `the platform runs Python ${supportedRange()}`;
  throw new UnsupportedPythonError(
    `${source} pins Python ${version}; ${reason}. Pin a supported version ` +
      `(${supportedRange()}).`,
  );
}

function fromVersionFile(text: string): PythonVersion | undefined {
  const line = text.split("\n").map((l) => l.replace(/#.*$/, "").trim())
    .find(Boolean);
  const match = line &&
    /^(?:cpython-|python-?)?(\d+)\.(\d+)(?:\.\d+)?(?:[-\w.]*)?$/.exec(line);
  if (!match) return undefined;
  return pinned(".python-version", Number(match[1]), Number(match[2]));
}

function fromRuntimeTxt(text: string): PythonVersion | undefined {
  const match = /^\s*python-(\d+)\.(\d+)/m.exec(text);
  if (!match) return undefined;
  return pinned("runtime.txt", Number(match[1]), Number(match[2]));
}

function tomlValue(
  text: string,
  section: string,
  key: string,
): string | undefined {
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current !== section) continue;
    const match = new RegExp(
      String.raw`^${key}\s*=\s*(?:"([^"]*)"|'([^']*)')`,
    ).exec(line);
    if (match) return match[1] ?? match[2];
  }
  return undefined;
}

function fromPyproject(text: string): PythonVersion | undefined {
  const requires = tomlValue(text, "project", "requires-python");
  if (requires) {
    const version = pickAllowed(
      "pyproject.toml",
      requires,
      (minor) => pepAllows(requires, minor),
    );
    if (version) return version;
  }
  const poetry = tomlValue(text, "tool.poetry.dependencies", "python");
  if (poetry) {
    return pickAllowed(
      "pyproject.toml",
      poetry,
      (minor) => poetryAllows(poetry, minor),
    );
  }
  return undefined;
}

function fromPipfile(text: string): PythonVersion | undefined {
  const value = tomlValue(text, "requires", "python_version") ??
    tomlValue(text, "requires", "python_full_version");
  const match = value && /^(\d+)\.(\d+)/.exec(value);
  if (!match) return undefined;
  return pinned("Pipfile", Number(match[1]), Number(match[2]));
}

export function resolvePythonVersion(
  texts: Record<string, string>,
): PythonVersion {
  const sources: Array<[string, (text: string) => PythonVersion | undefined]> =
    [
      [".python-version", fromVersionFile],
      ["runtime.txt", fromRuntimeTxt],
      ["pyproject.toml", fromPyproject],
      ["Pipfile", fromPipfile],
    ];
  for (const [file, read] of sources) {
    const text = texts[file];
    if (text === undefined) continue;
    const version = read(text);
    if (version) return version;
  }
  return DEFAULT_PYTHON_VERSION;
}
