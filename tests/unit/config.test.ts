import { assertEquals } from "@std/assert";
import {
  clearEnvironments,
  DEFAULT_BACKEND_URL,
  DEFAULT_EXT_URL,
  defaultConfig,
  readLinkFile,
  removeEnvironment,
  removeEnvironmentFor,
  resolveCloudAuth,
  upsertEnvironment,
} from "../../src/config.ts";
import { join } from "@std/path";

Deno.test("resolveCloudAuth prefers env over file", () => {
  const c = {
    ...defaultConfig(),
    cloud: { backendUrl: "https://file", userToken: "ft", userId: "u1" },
  };
  const auth = resolveCloudAuth(c, {
    PB_TOKEN: "envtok",
    PB_BACKEND_URL: "https://env",
  });
  assertEquals(auth, {
    backendUrl: "https://env",
    // A custom backend cannot imply an extension host, so none is guessed.
    extUrl: undefined,
    userToken: "envtok",
    userId: "",
  });
});

Deno.test("resolveCloudAuth pairs the two hosts from the environment", () => {
  const auth = resolveCloudAuth(defaultConfig(), {
    PB_TOKEN: "envtok",
    PB_BACKEND_URL: "http://localhost:8090",
    PB_BACKEND_EXT_URL: "http://localhost:8041",
  });
  assertEquals(auth?.extUrl, "http://localhost:8041");
});

Deno.test("resolveCloudAuth defaults the extension host for the default backend", () => {
  const auth = resolveCloudAuth(defaultConfig(), {
    PB_TOKEN: "envtok",
    PB_BACKEND_URL: DEFAULT_BACKEND_URL,
  });
  assertEquals(auth?.extUrl, DEFAULT_EXT_URL);
});

Deno.test("resolveCloudAuth falls back to file", () => {
  const c = {
    ...defaultConfig(),
    cloud: { backendUrl: "https://file", userToken: "ft", userId: "u1" },
  };
  assertEquals(resolveCloudAuth(c, {}), {
    backendUrl: "https://file",
    // Filled in for configs written before the CLI knew about the second host.
    extUrl: DEFAULT_EXT_URL,
    userToken: "ft",
    userId: "u1",
  });
});

Deno.test("resolveCloudAuth null when unauthenticated", () => {
  assertEquals(resolveCloudAuth(defaultConfig(), {}), null);
});

Deno.test("readLinkFile returns null when pb.json has no projectId", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "pb.json"),
      JSON.stringify({ pocketbaseVersion: "0.39.9" }),
    );
    assertEquals(await readLinkFile(dir), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readLinkFile returns null when projectId is empty", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "pb.json"),
      JSON.stringify({ projectId: "", backendUrl: "https://b" }),
    );
    assertEquals(await readLinkFile(dir), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readLinkFile reads projectId, version pin, and environments", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "pb.json"),
      JSON.stringify({
        projectId: "p1",
        pocketbaseVersion: "0.39.9",
        kind: "frontends",
        defaultEnvironment: "production",
        environments: {
          production: { id: "fe1", name: "web" },
          staging: {
            id: "fe2",
            name: "web-staging",
            build: { envFile: ".env.staging" },
          },
        },
      }),
    );
    assertEquals(await readLinkFile(dir), {
      projectId: "p1",
      pocketbaseVersion: "0.39.9",
      kind: "frontends",
      defaultEnvironment: "production",
      environments: {
        production: { id: "fe1", name: "web" },
        staging: {
          id: "fe2",
          name: "web-staging",
          build: { envFile: ".env.staging" },
        },
      },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function withFile(
  dir: string,
  file: Record<string, unknown>,
): Promise<void> {
  await Deno.writeTextFile(join(dir, "pb.json"), JSON.stringify(file));
}

Deno.test("upsertEnvironment creates a self-contained pb.json when absent", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await upsertEnvironment(dir, {
      projectId: "p1",
      kind: "frontends",
      environment: "production",
      entry: { id: "fe1", name: "web" },
    });
    assertEquals(await readLinkFile(dir), {
      projectId: "p1",
      kind: "frontends",
      defaultEnvironment: "production",
      environments: { production: { id: "fe1", name: "web" } },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upsertEnvironment adds a second environment beside the first", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await upsertEnvironment(dir, {
      projectId: "p1",
      kind: "frontends",
      environment: "production",
      entry: { id: "fe1", name: "web" },
    });
    await upsertEnvironment(dir, {
      projectId: "p1",
      kind: "frontends",
      environment: "staging",
      entry: { id: "fe2", name: "web-staging" },
    });
    const link = await readLinkFile(dir);
    assertEquals(link?.environments, {
      production: { id: "fe1", name: "web" },
      staging: { id: "fe2", name: "web-staging" },
    });
    // The first environment recorded stays the default.
    assertEquals(link?.defaultEnvironment, "production");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upsertEnvironment preserves unrelated fields and the env's build block", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withFile(dir, {
      projectId: "p1",
      pocketbaseVersion: "0.39.9",
      kind: "frontends",
      build: { command: "npm run build" },
      defaultEnvironment: "production",
      environments: {
        staging: {
          id: "old",
          name: "web-staging",
          build: { envFile: ".env.staging" },
        },
      },
    });
    await upsertEnvironment(dir, {
      projectId: "p1",
      kind: "frontends",
      environment: "staging",
      entry: { id: "fe2", name: "web-staging" },
    });
    assertEquals(await readLinkFile(dir), {
      projectId: "p1",
      pocketbaseVersion: "0.39.9",
      kind: "frontends",
      build: { command: "npm run build" },
      defaultEnvironment: "production",
      environments: {
        staging: {
          id: "fe2",
          name: "web-staging",
          build: { envFile: ".env.staging" },
        },
      },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upsertEnvironment repoints projectId at the resource's project", async () => {
  // Otherwise `pb cloud link --project other …` would leave the file naming a
  // project the bound resource does not live in.
  const dir = await Deno.makeTempDir();
  try {
    await withFile(dir, {
      projectId: "old",
      kind: "frontends",
      environments: { production: { id: "fe1", name: "web" } },
    });
    await upsertEnvironment(dir, {
      projectId: "new",
      kind: "frontends",
      environment: "production",
      entry: { id: "fe9", name: "web" },
    });
    assertEquals((await readLinkFile(dir))?.projectId, "new");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("removeEnvironment drops the last environment along with kind", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withFile(dir, {
      projectId: "p1",
      kind: "pocketbases",
      build: { command: "x" },
      defaultEnvironment: "production",
      environments: { production: { id: "pb1", name: "main" } },
    });
    assertEquals(await removeEnvironment(dir, "production"), {
      removed: true,
      emptied: true,
    });
    assertEquals(await readLinkFile(dir), {
      projectId: "p1",
      build: { command: "x" },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("removeEnvironment repoints the default at a sole survivor", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withFile(dir, {
      projectId: "p1",
      kind: "frontends",
      defaultEnvironment: "production",
      environments: {
        production: { id: "fe1", name: "web" },
        staging: { id: "fe2", name: "web-staging" },
      },
    });
    assertEquals(await removeEnvironment(dir, "production"), {
      removed: true,
      repointedTo: "staging",
    });
    assertEquals((await readLinkFile(dir))?.defaultEnvironment, "staging");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("removeEnvironment drops the default when several remain", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withFile(dir, {
      projectId: "p1",
      kind: "frontends",
      defaultEnvironment: "production",
      environments: {
        production: { id: "fe1", name: "web" },
        staging: { id: "fe2", name: "s" },
        preview: { id: "fe3", name: "p" },
      },
    });
    assertEquals(await removeEnvironment(dir, "production"), {
      removed: true,
      defaultDropped: true,
    });
    const link = await readLinkFile(dir);
    assertEquals(link?.defaultEnvironment, undefined);
    assertEquals(Object.keys(link?.environments ?? {}), ["staging", "preview"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("removeEnvironment leaves a non-default environment's default alone", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withFile(dir, {
      projectId: "p1",
      kind: "frontends",
      defaultEnvironment: "production",
      environments: {
        production: { id: "fe1", name: "web" },
        staging: { id: "fe2", name: "s" },
      },
    });
    assertEquals(await removeEnvironment(dir, "staging"), { removed: true });
    assertEquals((await readLinkFile(dir))?.defaultEnvironment, "production");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("removeEnvironmentFor only detaches the environment holding that id", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withFile(dir, {
      projectId: "p1",
      kind: "frontends",
      defaultEnvironment: "production",
      environments: { production: { id: "fe1", name: "web" } },
    });
    // `rm --name something-else` resolved a resource this environment does not
    // track, so the binding must survive.
    assertEquals(await removeEnvironmentFor(dir, "production", "other"), {
      removed: false,
    });
    assertEquals(
      (await readLinkFile(dir))?.environments?.production.id,
      "fe1",
    );
    assertEquals(await removeEnvironmentFor(dir, "production", "fe1"), {
      removed: true,
      emptied: true,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("clearEnvironments drops them all but keeps projectId and build", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withFile(dir, {
      projectId: "p1",
      kind: "pocketbases",
      build: { command: "x" },
      defaultEnvironment: "production",
      environments: {
        production: { id: "pb1", name: "main" },
        staging: { id: "pb2", name: "main-staging" },
      },
    });
    assertEquals(await clearEnvironments(dir), ["production", "staging"]);
    assertEquals(await readLinkFile(dir), {
      projectId: "p1",
      build: { command: "x" },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
