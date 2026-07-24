import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderJson, renderTable } from "../../src/ui/output.ts";

type Row = { name: string; status: string };
const cols = [
  { header: "NAME", get: (r: Row) => r.name },
  { header: "STATUS", get: (r: Row) => r.status },
];

Deno.test("renderTable aligns columns and includes headers", () => {
  const out = renderTable([{ name: "app", status: "running" }], cols);
  assertStringIncludes(out, "NAME");
  assertStringIncludes(out, "STATUS");
  assertStringIncludes(out, "app");
  assertStringIncludes(out, "running");
});

Deno.test("renderTable handles empty rows", () => {
  assertEquals(renderTable([], cols).trim(), "NAME  STATUS");
});

Deno.test("renderJson is stable pretty JSON", () => {
  assertEquals(renderJson({ a: 1 }), '{\n  "a": 1\n}');
});
