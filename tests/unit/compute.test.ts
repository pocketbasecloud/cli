import { assertEquals } from "@std/assert";
import {
  computeLabel,
  humanizeLocationCode,
  locationCity,
  resourceLocationLabel,
} from "../../src/ui/compute.ts";

Deno.test("computeLabel numbers from one and names the city", () => {
  assertEquals(computeLabel(0, "GRA"), "Compute 1 — Gravelines");
  assertEquals(computeLabel(2, "hil"), "Compute 3 — Hillsboro, OR");
});

Deno.test("computeLabel drops the city when the record has no location", () => {
  assertEquals(computeLabel(0), "Compute 1");
  assertEquals(computeLabel(1, ""), "Compute 2");
});

Deno.test("computeLabel appends the shortKey to distinguish compute in the same location", () => {
  assertEquals(computeLabel(0, "GRA", "ab12"), "Compute 1 — Gravelines (ab12)");
  assertEquals(computeLabel(1, "GRA", "cd34"), "Compute 2 — Gravelines (cd34)");
});

Deno.test("computeLabel omits the shortKey parenthetical when absent", () => {
  assertEquals(computeLabel(0, "GRA", ""), "Compute 1 — Gravelines");
  assertEquals(computeLabel(0, "GRA", undefined), "Compute 1 — Gravelines");
});

Deno.test("an unknown datacenter code is humanized rather than hidden", () => {
  assertEquals(locationCity("xyz"), "XYZ");
  assertEquals(humanizeLocationCode("new-region"), "NEW Region");
  assertEquals(computeLabel(0, "waw2"), "Compute 1 — Waw2");
});

Deno.test("resourceLocationLabel names the city for a dedicated compute", () => {
  assertEquals(
    resourceLocationLabel({ computeLocation: "GRA", computeShared: false }),
    "Gravelines",
  );
});

Deno.test("resourceLocationLabel shows the shared cluster's real location", () => {
  assertEquals(
    resourceLocationLabel({ computeLocation: "fsn1", computeShared: true }),
    "Shared Cluster — Falkenstein",
  );
});

Deno.test("resourceLocationLabel falls back to a bare shared-cluster label without a location", () => {
  assertEquals(
    resourceLocationLabel({ computeShared: true }),
    "Shared Cluster",
  );
});

Deno.test("resourceLocationLabel shows a dash, not shared cluster, for a dedicated compute with no known location", () => {
  assertEquals(
    resourceLocationLabel({ computeShared: false }),
    "-",
  );
});

Deno.test("resourceLocationLabel shows a dash when nothing is known", () => {
  assertEquals(resourceLocationLabel(undefined), "-");
  assertEquals(resourceLocationLabel({}), "-");
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
  assertEquals(locationCity("jp-tyo"), "Japan");
  assertEquals(locationCity("in-bom"), "India");
  assertEquals(locationCity("us-central"), "US Central");
  assertEquals(locationCity("us-east"), "US East");
  assertEquals(locationCity("us-west"), "US West");
});
