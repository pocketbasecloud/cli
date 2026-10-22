import { assertEquals } from "@std/assert";
import type { GitRunner } from "../../src/commands/ci.ts";
import { githubRepoOf, readDeployCommit } from "../../src/git-commit.ts";

function fakeGit(answers: Record<string, string | null>): GitRunner {
  return (args) => {
    const key = args.join(" ");
    const match = Object.keys(answers).find((k) => key.startsWith(k));
    const out = match === undefined ? null : answers[match];
    return Promise.resolve(
      out === null ? { code: 1, stdout: "" } : { code: 0, stdout: out },
    );
  };
}

const SHA = "4f2a91c0ffee4f2a91c0ffee4f2a91c0ffee4f2a";

Deno.test("githubRepoOf reads ssh and https GitHub remotes only", () => {
  assertEquals(githubRepoOf("git@github.com:acme/blog.git"), "acme/blog");
  assertEquals(githubRepoOf("https://github.com/acme/blog"), "acme/blog");
  assertEquals(githubRepoOf("https://gitlab.com/acme/blog.git"), undefined);
});

Deno.test("readDeployCommit names a pushed GitHub commit", async () => {
  const commit = await readDeployCommit(
    "/repo",
    fakeGit({
      "rev-parse HEAD": SHA,
      "log -1": "Fix login hook\x1fJane Doe",
      "status --porcelain": "",
      "remote get-url origin": "git@github.com:acme/blog.git",
      "branch -r --contains": "  origin/main",
    }),
  );
  assertEquals(commit, {
    sha: SHA,
    title: "Fix login hook",
    author: "Jane Doe",
    repo: "acme/blog",
  });
});

Deno.test("readDeployCommit flags uncommitted changes and leaves out an unpushed repo", async () => {
  const commit = await readDeployCommit(
    "/repo",
    fakeGit({
      "rev-parse HEAD": SHA,
      "log -1": "WIP\x1fJane Doe",
      "status --porcelain": " M pb_hooks/main.pb.js",
      "remote get-url origin": "git@github.com:acme/blog.git",
      "branch -r --contains": "",
    }),
  );
  assertEquals(commit, {
    sha: SHA,
    title: "WIP (with uncommitted changes)",
    author: "Jane Doe",
  });
});

Deno.test("readDeployCommit is null outside a git checkout", async () => {
  assertEquals(await readDeployCommit("/tmp", fakeGit({})), null);
});
