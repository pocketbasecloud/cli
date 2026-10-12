import { assertEquals } from "@std/assert";
import { promptSecret } from "../../../src/ui/prompt.ts";

Deno.test("promptSecret reads through the hidden reader, keeping spaces", async () => {
  let visibleReads = 0;
  const answer = await promptSecret("Password:", {
    noInput: false,
    io: {
      read: () => {
        visibleReads++;
        return Promise.resolve("echoed");
      },
      readHidden: () => Promise.resolve(" p@ss word "),
      write: () => {},
      isTTY: true,
    },
  });
  assertEquals(answer, " p@ss word ");
  assertEquals(visibleReads, 0);
});
