import { assertEquals, assertThrows } from "@std/assert";
import {
  inferPythonStart,
  isPythonProject,
  pythonFilesToRead,
  resolvePythonVersion,
  UnsupportedPythonError,
} from "../../../src/build/python-detect.ts";
import { PYTHON_PROJECT_CORPUS } from "./python-projects.corpus.ts";

function startOf(files: Record<string, string>) {
  const paths = Object.keys(files);
  const texts: Record<string, string> = {};
  for (const path of pythonFilesToRead(paths)) texts[path] = files[path];
  return inferPythonStart(paths, texts);
}

for (const project of PYTHON_PROJECT_CORPUS) {
  Deno.test(`python start: ${project.name}`, () => {
    assertEquals(startOf(project.files), project.expected);
  });
}

Deno.test("python projects are recognised by a manifest or a root script", () => {
  assertEquals(isPythonProject(["uv.lock"]), true);
  assertEquals(isPythonProject(["bot.py"]), true);
  assertEquals(isPythonProject(["scripts/build.py", "index.html"]), false);
});

Deno.test("the files to read cover manifests, version pins and entry candidates", () => {
  assertEquals(
    pythonFilesToRead([
      "requirements.txt",
      "requirements/base.txt",
      ".python-version",
      "runtime.txt",
      "Procfile",
      "manage.py",
      "app/main.py",
      "app/models.py",
      "static/app.js",
    ]).sort(),
    [
      ".python-version",
      "Procfile",
      "app/main.py",
      "manage.py",
      "requirements.txt",
      "requirements/base.txt",
      "runtime.txt",
    ],
  );
});

Deno.test("dev-only servers are not treated as installed", () => {
  assertEquals(
    startOf({
      "main.py": "from fastapi import FastAPI\n\napp = FastAPI()\n",
      "Pipfile": '[packages]\nfastapi = "*"\n\n[dev-packages]\nuvicorn = "*"\n',
    }).startCommand,
    "uvicorn main:app --host 0.0.0.0 --port $PORT",
  );
  assertEquals(
    startOf({
      "app.py": "from flask import Flask\n\napp = Flask(__name__)\n",
      "pyproject.toml":
        '[tool.poetry.dependencies]\npython = "^3.12"\nflask = "^3"\n\n[tool.poetry.group.dev.dependencies]\ngunicorn = "*"\n',
    }).startCommand,
    "flask --app app run --host 0.0.0.0 --port $PORT",
  );
});

Deno.test("a gunicorn factory target is quoted for the shell", () => {
  assertEquals(
    startOf({
      "requirements.txt": "flask\ngunicorn\n",
      "app/__init__.py":
        "from flask import Flask\n\n\ndef create_app():\n    return Flask(__name__)\n",
    }).startCommand,
    'gunicorn "app:create_app()" --bind 0.0.0.0:$PORT',
  );
});

const VERSION_CASES: Array<[string, Record<string, string>, string]> = [
  ["no pin defaults", {}, "3.12"],
  [".python-version patch", { ".python-version": "3.11.9\n" }, "3.11"],
  [
    ".python-version comment",
    { ".python-version": "# pinned\n3.13\n" },
    "3.13",
  ],
  [
    ".python-version pypy is ignored",
    { ".python-version": "pypy3.10\n" },
    "3.12",
  ],
  ["runtime.txt", { "runtime.txt": "python-3.10.14\n" }, "3.10"],
  ["requires-python floor", {
    "pyproject.toml": '[project]\nrequires-python = ">=3.10"\n',
  }, "3.12"],
  ["requires-python above default", {
    "pyproject.toml": '[project]\nrequires-python = ">=3.13"\n',
  }, "3.13"],
  ["requires-python ceiling", {
    "pyproject.toml": '[project]\nrequires-python = ">=3.9,<3.12"\n',
  }, "3.11"],
  ["requires-python compatible release", {
    "pyproject.toml": '[project]\nrequires-python = "~=3.11.2"\n',
  }, "3.11"],
  ["requires-python wildcard exclusion", {
    "pyproject.toml": '[project]\nrequires-python = ">=3.11,!=3.12.*"\n',
  }, "3.11"],
  ["requires-python legacy floor", {
    "pyproject.toml": "[project]\nrequires-python = '>=2.7'\n",
  }, "3.12"],
  ["poetry caret", {
    "pyproject.toml": '[tool.poetry.dependencies]\npython = "^3.13"\n',
  }, "3.13"],
  ["poetry tilde", {
    "pyproject.toml": '[tool.poetry.dependencies]\npython = "~3.10"\n',
  }, "3.10"],
  ["poetry alternatives", {
    "pyproject.toml":
      '[tool.poetry.dependencies]\npython = ">=3.10,<3.11 || >=3.13"\n',
  }, "3.13"],
  ["Pipfile", { "Pipfile": '[requires]\npython_version = "3.11"\n' }, "3.11"],
  ["Pipfile full version", {
    "Pipfile": '[requires]\npython_full_version = "3.13.1"\n',
  }, "3.13"],
  [".python-version beats pyproject", {
    ".python-version": "3.11\n",
    "pyproject.toml": '[project]\nrequires-python = ">=3.13"\n',
  }, "3.11"],
];

for (const [name, texts, expected] of VERSION_CASES) {
  Deno.test(`python version: ${name}`, () => {
    assertEquals(resolvePythonVersion(texts), expected);
  });
}

const REFUSED_VERSIONS: Array<[string, Record<string, string>, string]> = [
  [
    "Python 2 pin",
    { ".python-version": "2.7.18\n" },
    "Python 2 is not supported",
  ],
  ["too old a pin", { "runtime.txt": "python-3.8.10\n" }, "Python 3.8"],
  ["Pipfile Python 2", {
    "Pipfile": '[requires]\npython_version = "2.7"\n',
  }, "Python 2 is not supported"],
  ["requires-python below 3", {
    "pyproject.toml": '[project]\nrequires-python = "<3"\n',
  }, "excludes every version"],
  ["requires-python old ceiling", {
    "pyproject.toml": '[project]\nrequires-python = ">=3.7,<3.10"\n',
  }, "excludes every version"],
];

for (const [name, texts, message] of REFUSED_VERSIONS) {
  Deno.test(`python version refused: ${name}`, () => {
    assertThrows(
      () => resolvePythonVersion(texts),
      UnsupportedPythonError,
      message,
    );
  });
}
