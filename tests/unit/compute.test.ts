import { assertEquals } from "@std/assert";
import {
  computeLabel,
  humanizeLocationCode,
  locationCity,
} from "../../src/ui/compute.ts";

Deno.test("computeLabel numbers from one and names the city", () => {
  // The portal shows exactly this string for the same machine.
  assertEquals(computeLabel(0, "GRA"), "Compute 1 — Gravelines");
  assertEquals(computeLabel(2, "hil"), "Compute 3 — Hillsboro, OR");
});

Deno.test("computeLabel drops the city when the record has no location", () => {
  assertEquals(computeLabel(0), "Compute 1");
  assertEquals(computeLabel(1, ""), "Compute 2");
});

Deno.test("an unknown datacenter code is humanized rather than hidden", () => {
  // Better a readable code than no location at all when the catalog grows a
  // region this table has not learned yet.
  assertEquals(locationCity("xyz"), "XYZ");
  assertEquals(humanizeLocationCode("new-region"), "NEW Region");
  assertEquals(computeLabel(0, "waw2"), "Compute 1 — Waw2");
});
