import { assertEquals } from "@std/assert";
import {
  computeLabel,
  humanizeLocationCode,
  locationCity,
} from "../../src/ui/compute.ts";

Deno.test("computeLabel numbers from one and names the city", () => {
  assertEquals(computeLabel(0, "GRA"), "Compute 1 — Gravelines");
  assertEquals(computeLabel(2, "hil"), "Compute 3 — Hillsboro, OR");
});

Deno.test("computeLabel drops the city when the record has no location", () => {
  assertEquals(computeLabel(0), "Compute 1");
  assertEquals(computeLabel(1, ""), "Compute 2");
});

Deno.test("an unknown datacenter code is humanized rather than hidden", () => {
  assertEquals(locationCity("xyz"), "XYZ");
  assertEquals(humanizeLocationCode("new-region"), "NEW Region");
  assertEquals(computeLabel(0, "waw2"), "Compute 1 — Waw2");
});

Deno.test("every provider and custom location code names a real city", () => {
  assertEquals(locationCity("fsn1"), "Falkenstein");
  assertEquals(locationCity("nbg1"), "Nuremberg");
  assertEquals(locationCity("hel1"), "Helsinki");
  assertEquals(locationCity("ash"), "Ashburn, VA");
  assertEquals(locationCity("hil"), "Hillsboro, OR");
  assertEquals(locationCity("sin"), "Singapore");
  assertEquals(locationCity("GRA"), "Gravelines");
  assertEquals(locationCity("SBG"), "Strasbourg");
  assertEquals(locationCity("RBX"), "Roubaix");
  assertEquals(locationCity("DE"), "Frankfurt");
  assertEquals(locationCity("UK"), "London");
  assertEquals(locationCity("WAW"), "Warsaw");
  assertEquals(locationCity("BHS"), "Beauharnois");
  assertEquals(locationCity("VIN"), "Vint Hill, VA");
  assertEquals(locationCity("SGP"), "Singapore");
  assertEquals(locationCity("SYD"), "Sydney");
  assertEquals(locationCity("SGN"), "Ho Chi Minh City");
  assertEquals(locationCity("vn-han"), "Hanoi");
  assertEquals(locationCity("vn-sgn"), "Ho Chi Minh City");
  assertEquals(locationCity("vn-dad"), "Da Nang");
});
