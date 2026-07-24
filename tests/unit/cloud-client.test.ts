import { assertEquals } from "@std/assert";
import { createMockCloudClient } from "../mocks/cloud.mock.ts";

Deno.test("mock createResource records the call and returns a resource", async () => {
  const c = createMockCloudClient();
  const r = await c.createResource("pocketbases", {
    name: "db1",
    project: "p1",
  });
  assertEquals(r.name, "db1");
  assertEquals(c.calls.createResource.length, 1);
  assertEquals(c.calls.createResource[0], ["pocketbases", {
    name: "db1",
    project: "p1",
  }]);
});
