import { assertEquals, assertRejects } from "@std/assert";
import {
  backendExtUrl,
  backendUrl,
  configPath,
  defaultConfig,
  envVar,
  envVarName,
  legacyConfigPath,
  linkFilePath,
  loadConfig,
  readLinkFile,
  readOwnLinkFile,
  removeEnvironment,
  removeEnvironmentFor,
  resolveCloudAuth,
  saveConfig,
  upsertEnvironment,
} from "../../src/config.ts";
import { join } from "@std/path";

Deno.test("resolveCloudAuth takes the token from the env over the file", () => {
  const c = {
    ...defaultConfig(),
    cloud: {
      backendUrl: "https://file",
      extUrl: "https://file-ext",
      userToken: "ft",
      userId: "u1",
    },
  };
  const auth = resolveCloudAuth(c, { PBC_TOKEN: "envtok" });
  assertEquals(auth, {
    backendUrl: backendUrl(),
    extUrl: backendExtUrl(),
    userToken: "envtok",
    userId: "",
  });
});

Deno.test("resolveCloudAuth stamps the production hosts", () => {
  const auth = resolveCloudAuth(defaultConfig(), { PBC_TOKEN: "envtok" });
  assertEquals(auth?.backendUrl, backendUrl());
  assertEquals(auth?.extUrl, backendExtUrl());
});

Deno.test("resolveCloudAuth falls back to file", () => {
  const c = {
    ...defaultConfig(),
    cloud: {
      backendUrl: "https://file",
      extUrl: "https://file-ext",
      userToken: "ft",
      userId: "u1",
    },
  };
  assertEquals(resolveCloudAuth(c, {}), {
    backendUrl: backendUrl(),
    extUrl: backendExtUrl(),
    userToken: "ft",
    userId: "u1",
  });
});

Deno.test("resolveCloudAuth null when unauthenticated", () => {
  assertEquals(resolveCloudAuth(defaultConfig(), {}), null);
});

Deno.test("readLinkFile returns null when pbc.json has no projectId", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "pbc.json"),
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
      join(dir, "pbc.json"),
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
      join(dir, "pbc.json"),
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
  await Deno.writeTextFile(join(dir, "pbc.json"), JSON.stringify(file));
}

Deno.test("upsertEnvironment creates a self-contained pbc.json when absent", async () => {
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

Deno.test("upsertEnvironment merges an entry's build over the env's own, key by key", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withFile(dir, {
      projectId: "p1",
      kind: "backends",
      environments: {
        prod: {
          id: "be1",
          name: "api",
          build: { runtime: "deno", exclude: ["*.map"] },
        },
      },
    });
    await upsertEnvironment(dir, {
      projectId: "p1",
      kind: "backends",
      environment: "prod",
      entry: { id: "be1", name: "api", build: { envFile: ".env.prod" } },
    });
    assertEquals((await readLinkFile(dir))?.environments?.prod.build, {
      runtime: "deno",
      exclude: ["*.map"],
      envFile: ".env.prod",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upsertEnvironment repoints projectId at the resource's project", async () => {
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

Deno.test("removeEnvironment does not walk up to a parent pbc.json", async () => {
  const parent = await Deno.makeTempDir();
  try {
    const child = join(parent, "frontend");
    await Deno.mkdir(child);
    const parentFile = JSON.stringify({
      projectId: "p1",
      kind: "frontends",
      defaultEnvironment: "production",
      environments: { production: { id: "fe1", name: "web" } },
    });
    await Deno.writeTextFile(join(parent, "pbc.json"), parentFile);
    assertEquals(await removeEnvironment(child, "production"), { removed: false });
    assertEquals(await Deno.readTextFile(join(parent, "pbc.json")), parentFile);
    await assertRejects(() => Deno.readTextFile(join(child, "pbc.json")));
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("envVar prefers the PBC_ name and falls back to the PB_ one", () => {
  assertEquals(envVar("TOKEN", { PBC_TOKEN: "new", PB_TOKEN: "old" }), "new");
  assertEquals(envVar("TOKEN", { PB_TOKEN: "old" }), "old");
  assertEquals(envVar("TOKEN", {}), undefined);
  assertEquals(envVar("TOKEN", { PBC_TOKEN: "", PB_TOKEN: "old" }), "old");
  assertEquals(envVar("TOKEN", { PBC_TOKEN: "", PB_TOKEN: "" }), undefined);
});

Deno.test("a pre-0.6.0 PB_TOKEN still authenticates", () => {
  assertEquals(
    resolveCloudAuth(defaultConfig(), { PB_TOKEN: "old" })?.userToken,
    "old",
  );
  assertEquals(
    resolveCloudAuth(defaultConfig(), { PB_TOKEN: "old", PBC_TOKEN: "new" })
      ?.userToken,
    "new",
  );
});

Deno.test("envVarName reports the spelling that is actually set", () => {
  assertEquals(envVarName("TOKEN", { PB_TOKEN: "old" }), "PB_TOKEN");
  assertEquals(
    envVarName("TOKEN", { PB_TOKEN: "old", PBC_TOKEN: "new" }),
    "PBC_TOKEN",
  );
  assertEquals(envVarName("TOKEN", {}), undefined);
  assertEquals(envVarName("TOKEN", { PBC_TOKEN: "" }), undefined);
});

Deno.test("the config lives under pbc/, and pb/ is where it used to", () => {
  assertEquals(
    configPath({ XDG_CONFIG_HOME: "/x/cfg" }),
    join("/x/cfg", "pbc", "config.json"),
  );
  assertEquals(
    legacyConfigPath({ XDG_CONFIG_HOME: "/x/cfg" }),
    join("/x/cfg", "pb", "config.json"),
  );
});

Deno.test("loadConfig reads the pre-0.6.0 config, and saveConfig moves it", async () => {
  const home = await Deno.makeTempDir();
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  Deno.env.set("XDG_CONFIG_HOME", home);
  try {
    await Deno.mkdir(join(home, "pb"), { recursive: true });
    await Deno.writeTextFile(
      join(home, "pb", "config.json"),
      JSON.stringify({ ...defaultConfig(), currentProject: "p-old" }),
    );

    const loaded = await loadConfig();
    assertEquals(loaded.currentProject, "p-old");

    await saveConfig({ ...loaded, currentProject: "p-new" });
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(home, "pbc", "config.json")))
        .currentProject,
      "p-new",
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(home, "pb", "config.json")))
        .currentProject,
      "p-old",
    );
    assertEquals((await loadConfig()).currentProject, "p-new");
  } finally {
    if (xdg === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", xdg);
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("a directory holding pb.json is read, and written back in place", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "pb.json"),
      JSON.stringify({
        projectId: "p1",
        kind: "frontends",
        defaultEnvironment: "production",
        environments: { production: { id: "fe1", name: "web" } },
      }),
    );
    assertEquals((await readLinkFile(dir))?.projectId, "p1");
    assertEquals(await linkFilePath(dir), join(dir, "pb.json"));

    await upsertEnvironment(dir, {
      projectId: "p1",
      kind: "frontends",
      environment: "staging",
      entry: { id: "fe2", name: "web-staging" },
    });

    const written = JSON.parse(await Deno.readTextFile(join(dir, "pb.json")));
    assertEquals(Object.keys(written.environments), ["production", "staging"]);
    assertEquals(await exists(join(dir, "pbc.json")), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pbc.json wins when a directory somehow has both", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "pb.json"),
      JSON.stringify({ projectId: "old" }),
    );
    await Deno.writeTextFile(
      join(dir, "pbc.json"),
      JSON.stringify({ projectId: "new" }),
    );
    assertEquals((await readLinkFile(dir))?.projectId, "new");
    assertEquals((await readOwnLinkFile(dir)).projectId, "new");
    assertEquals(await linkFilePath(dir), join(dir, "pbc.json"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
