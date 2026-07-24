import { assertEquals } from "@std/assert";
import { createMockAdminClient } from "../mocks/admin.mock.ts";

Deno.test("mock createRecord tracks call and returns a record with id", async () => {
  const c = createMockAdminClient();
  const r = await c.createRecord("posts", { title: "hi" });
  assertEquals(r.title, "hi");
  assertEquals(typeof r.id, "string");
  assertEquals(c.calls.createRecord[0], ["posts", { title: "hi" }]);
});

Deno.test("mock listRecords returns a page shape", async () => {
  const c = createMockAdminClient();
  await c.createRecord("posts", { title: "a" });
  const page = await c.listRecords("posts", {});
  assertEquals(page.items.length, 1);
  assertEquals(page.page, 1);
});
