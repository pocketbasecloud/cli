import { assertEquals } from "@std/assert";
import { createMockAdminClient } from "../mocks/admin.mock.ts";
import { mapAdminError } from "../../src/clients/admin.ts";
import { ClientResponseError } from "pocketbase";

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

Deno.test("mapAdminError spells out which fields the instance rejected", () => {
  const e = mapAdminError(
    new ClientResponseError({
      url: "https://i.example.com/api/collections",
      status: 400,
      response: {
        code: 400,
        message: "Failed to create collection.",
        data: {
          name: {
            code: "validation_match_invalid",
            message: "Must be in a valid format.",
          },
        },
      },
    }),
  );
  assertEquals(
    e.message,
    "Instance error (400): Failed to create collection. — " +
      "name: Must be in a valid format.",
  );
  assertEquals(e.fields, { name: "validation_match_invalid" });
});
