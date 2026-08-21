import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import {
  envDigest,
  envStateKey,
  envStatePath,
  forgetEnvDigest,
  lastEnvDigest,
  recordEnvDigest,
} from "../../src/env-state.ts";

const statePath = () => join(Deno.makeTempDirSync(), "env-state.json");

Deno.test("the state file sits beside the config", () => {
  assertEquals(
    envStatePath({ XDG_CONFIG_HOME: "/x/cfg" }),
    join("/x/cfg", "pbc", "env-state.json"),
  );
  assertEquals(
    envStatePath({ HOME: "/home/t" }),
    join("/home/t", ".config", "pbc", "env-state.json"),
  );
});

Deno.test("the digest hashes values, not the file's formatting", async () => {
  const a = await envDigest({ A: "1", B: "2" }, false);
  // Key order is not a change: a dotenv file may be reordered or re-commented
  // without the platform ending up with anything different.
  assertEquals(await envDigest({ B: "2", A: "1" }, false), a);
  // Everything that changes what the platform stores is.
  assertNotEquals(await envDigest({ A: "1", B: "3" }, false), a);
  assertNotEquals(await envDigest({ A: "1" }, false), a);
  // Same variables, but --delete-missing also removes cloud-only keys, so it
  // is a different push and must not be skipped as a repeat.
  assertNotEquals(await envDigest({ A: "1", B: "2" }, true), a);
});

Deno.test("a digest round-trips, and forgetting drops it", async () => {
  const path = statePath();
  const key = envStateKey("backend", "r1");
  assertEquals(await lastEnvDigest(key, path), undefined);

  await recordEnvDigest(key, "abc", path);
  assertEquals(await lastEnvDigest(key, path), "abc");
  // Targets are independent: two resources fed the same file each push once.
  assertEquals(
    await lastEnvDigest(envStateKey("backend", "r2"), path),
    undefined,
  );
  assertEquals(
    await lastEnvDigest(envStateKey("pocketbase", "r1"), path),
    undefined,
  );

  await recordEnvDigest(key, "def", path);
  assertEquals(await lastEnvDigest(key, path), "def");

  await forgetEnvDigest(key, path);
  assertEquals(await lastEnvDigest(key, path), undefined);
});

Deno.test("recording keeps the entries of other targets", async () => {
  const path = statePath();
  await recordEnvDigest(envStateKey("backend", "r1"), "a", path);
  await recordEnvDigest(envStateKey("pocketbase", "r2"), "b", path);
  await forgetEnvDigest(envStateKey("backend", "r1"), path);
  assertEquals(await lastEnvDigest(envStateKey("pocketbase", "r2"), path), "b");
});

Deno.test("a corrupt or absent state file reads as nothing known", async () => {
  const path = statePath();
  await Deno.writeTextFile(path, "{not json");
  assertEquals(
    await lastEnvDigest(envStateKey("backend", "r1"), path),
    undefined,
  );
  // And it is repaired by the next write rather than left to poison every run.
  await recordEnvDigest(envStateKey("backend", "r1"), "a", path);
  assertEquals(await lastEnvDigest(envStateKey("backend", "r1"), path), "a");
});

Deno.test("entries older than the retention window are dropped on write", async () => {
  const path = statePath();
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      targets: {
        "backend:stale": { digest: "a", at: old },
        "backend:undated": { digest: "b" },
      },
    }),
  );
  // Still honoured while it is only being read — expiry is housekeeping, not a
  // TTL on correctness.
  assertEquals(await lastEnvDigest("backend:stale", path), "a");
  await recordEnvDigest(envStateKey("backend", "fresh"), "c", path);
  assertEquals(await lastEnvDigest("backend:stale", path), undefined);
  assertEquals(await lastEnvDigest("backend:undated", path), undefined);
  assertEquals(await lastEnvDigest(envStateKey("backend", "fresh"), path), "c");
});
