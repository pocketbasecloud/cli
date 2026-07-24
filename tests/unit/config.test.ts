import { assertEquals } from "@std/assert";
import {
  clearResourceLink,
  defaultConfig,
  readLinkFile,
  resolveCloudAuth,
  upsertResourceLink,
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
    userToken: "envtok",
    userId: "",
  });
});

Deno.test("resolveCloudAuth falls back to file", () => {
  const c = {
    ...defaultConfig(),
    cloud: { backendUrl: "https://file", userToken: "ft", userId: "u1" },
  };
  assertEquals(resolveCloudAuth(c, {}), {
    backendUrl: "https://file",
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

Deno.test("readLinkFile reads projectId, version pin, and resource binding", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "pb.json"),
      JSON.stringify({
        projectId: "p1",
        pocketbaseVersion: "0.39.9",
        resource: { kind: "frontends", id: "fe1", name: "web" },
      }),
    );
    assertEquals(await readLinkFile(dir), {
      projectId: "p1",
      pocketbaseVersion: "0.39.9",
      resource: { kind: "frontends", id: "fe1", name: "web" },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upsertResourceLink creates a self-contained pb.json when absent", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await upsertResourceLink(dir, "p1", {
      kind: "frontends",
      id: "fe1",
      name: "web",
    });
    assertEquals(await readLinkFile(dir), {
      projectId: "p1",
      resource: { kind: "frontends", id: "fe1", name: "web" },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upsertResourceLink preserves unrelated fields", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "pb.json"),
      JSON.stringify({ projectId: "p1", pocketbaseVersion: "0.39.9" }),
    );
    await upsertResourceLink(dir, "p1", {
      kind: "backends",
      id: "be1",
      name: "api",
    });
    assertEquals(await readLinkFile(dir), {
      projectId: "p1",
      pocketbaseVersion: "0.39.9",
      resource: { kind: "backends", id: "be1", name: "api" },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upsertResourceLink repoints projectId at the resource's project", async () => {
  // Otherwise `pb cloud link --project other …` would leave the file naming a
  // project the bound resource does not live in.
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "pb.json"),
      JSON.stringify({
        projectId: "old",
        resource: { kind: "frontends", id: "fe1", name: "web" },
      }),
    );
    await upsertResourceLink(dir, "new", {
      kind: "backends",
      id: "be1",
      name: "api",
    });
    assertEquals(await readLinkFile(dir), {
      projectId: "new",
      resource: { kind: "backends", id: "be1", name: "api" },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("clearResourceLink drops the binding but keeps projectId", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "pb.json"),
      JSON.stringify({
        projectId: "p1",
        resource: { kind: "pocketbases", id: "pb1", name: "main" },
      }),
    );
    await clearResourceLink(dir);
    assertEquals(await readLinkFile(dir), { projectId: "p1" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
