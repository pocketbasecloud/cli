import { assertEquals } from "@std/assert";
import {
  defaultConfig,
  readLinkFile,
  resolveCloudAuth,
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

Deno.test("readLinkFile still reads a full link file, version pin and all", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "pb.json"),
      JSON.stringify({
        projectId: "p1",
        backendUrl: "https://b",
        pocketbaseVersion: "0.39.9",
      }),
    );
    assertEquals(await readLinkFile(dir), {
      projectId: "p1",
      backendUrl: "https://b",
      pocketbaseVersion: "0.39.9",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
