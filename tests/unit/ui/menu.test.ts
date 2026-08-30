import { assertEquals, assertStringIncludes } from "@std/assert";
import { chooseFromMenu } from "../../../src/ui/menu.ts";
import type { PromptIO } from "../../../src/ui/prompt.ts";

type Item = { name: string; id: string; project?: string; updated?: string };

function io(answers: string[]): PromptIO & { out: string } {
  const q = [...answers];
  const box = {
    out: "",
    read: () => Promise.resolve(q.shift() ?? null),
    write: (s: string) => {
      box.out += s;
    },
    isTTY: true,
  };
  return box as PromptIO & { out: string };
}

const key = (i: Item) => ({
  name: i.name,
  id: i.id,
  status: "running",
  project: i.project,
  updated: i.updated,
});

function menu(items: Item[], answers: string[], allowCreate = false) {
  const box = io(answers);
  return {
    box,
    result: chooseFromMenu({
      items,
      label: "PocketBase",
      verb: "Deploy to",
      allowCreate,
      key,
      opts: { noInput: false, io: box },
    }),
  };
}

Deno.test("the header states the count up front", async () => {
  const { box, result } = menu(
    [{ name: "a", id: "1" }, { name: "b", id: "2" }],
    ["2"],
  );
  const picked = await result;
  assertEquals(picked, { create: false, item: { name: "b", id: "2" } });
  assertStringIncludes(box.out, "Deploy to (2 PocketBases):");
});

Deno.test("the create row is pinned above the list and is choice 1", async () => {
  const { box, result } = menu(
    [{ name: "a", id: "1" }],
    ["1"],
    true,
  );
  assertEquals(await result, { create: true });
  const createLine = box.out.indexOf("+ Create a new PocketBase…");
  const firstItem = box.out.indexOf("a   running");
  assertEquals(createLine < firstItem, true);
  assertStringIncludes(box.out, "1) + Create a new PocketBase…");
});

Deno.test("the create row is present even with zero candidates", async () => {
  const { result } = menu([], ["1"], true);
  assertEquals(await result, { create: true });
});

Deno.test("rows are grouped by project only when more than one is represented", async () => {
  const grouped = menu(
    [
      { name: "api", id: "1", project: "acme-prod" },
      { name: "api", id: "2", project: "acme-staging" },
    ],
    ["2"],
  );
  await grouped.result;
  assertStringIncludes(grouped.box.out, "  acme-prod\n");
  assertStringIncludes(grouped.box.out, "  acme-staging\n");

  const flat = menu(
    [
      { name: "one", id: "1", project: "acme" },
      { name: "two", id: "2", project: "acme" },
    ],
    ["2"],
  );
  await flat.result;
  assertEquals(flat.box.out.includes("  acme\n"), false);
});

Deno.test("a long list is capped and offers a filter", async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    name: `pb-${i}`,
    id: `${i}`,
  }));
  const { box, result } = menu(items, ["pb-19", "1"]);
  await result;
  assertStringIncludes(box.out, "…8 more — type to filter");
  assertStringIncludes(box.out, "Deploy to (1 PocketBase):");
});

Deno.test("a filter that matches nothing re-prompts rather than erroring", async () => {
  const { box, result } = menu(
    [{ name: "web", id: "1" }],
    ["nope", "web", "1"],
  );
  await result;
  assertStringIncludes(box.out, 'No PocketBase matches "nope"');
});

Deno.test("above the threshold the menu opens in filter mode", async () => {
  const items = Array.from({ length: 60 }, (_, i) => ({
    name: `pb-${i}`,
    id: `${i}`,
  }));
  const { box, result } = menu(items, ["pb-7", "1"]);
  await result;
  assertStringIncludes(box.out, "60 PocketBases — type to filter");
});
