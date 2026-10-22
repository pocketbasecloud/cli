import { assertEquals } from "@std/assert";
import {
  linkedRepository,
  linkedWarning,
} from "../../src/clients/repo-link.ts";
import { createMockCloudClient } from "../mocks/cloud.mock.ts";

function answering(response: Response) {
  const asked: [string, unknown][] = [];
  const client = createMockCloudClient({
    ext: (path, _body, opts) => {
      asked.push([path, opts]);
      return Promise.resolve(response);
    },
  });
  return { client, asked };
}

Deno.test("linkedRepository returns an auto-deploying link of the instance", async () => {
  const { client, asked } = answering(
    Response.json({
      data: { repoFullName: "acme/app", branch: "main", autoDeploy: true },
    }),
  );
  const link = await linkedRepository(client, "pb1");
  assertEquals(link?.repoFullName, "acme/app");
  assertEquals(asked, [["/api/github/links", {
    method: "GET",
    query: { resourceKind: "pocketbases", resourceId: "pb1" },
  }]]);
  assertEquals(
    linkedWarning("db1", link!),
    "db1 deploys from acme/app (main). The next push there replaces what you change here. To keep it, commit it to the repository, or use Push to GitHub on the instance's Code page.",
  );
});

Deno.test("linkedRepository is quiet without a link, with auto-deploy off, or when GitHub is off", async () => {
  for (
    const response of [
      Response.json({ data: null }),
      Response.json({
        data: { repoFullName: "acme/app", branch: "main", autoDeploy: false },
      }),
      Response.json({ message: "GitHub is not configured" }, { status: 503 }),
    ]
  ) {
    assertEquals(
      await linkedRepository(answering(response).client, "pb1"),
      null,
    );
  }
});
