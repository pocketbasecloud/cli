import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  describePlan,
  renderDetail,
  renderJson,
  renderTable,
} from "../../src/ui/output.ts";

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

Deno.test("describePlan names the unsubscribed state instead of printing nothing", () => {
  assertEquals(describePlan("pro"), "pro");
  assertEquals(describePlan(""), "none (no active subscription)");
  assertEquals(describePlan(undefined), "none (no active subscription)");
});

Deno.test("renderDetail aligns labels and drops empty fields", () => {
  const out = renderDetail({ a: "1", b: "", c: "3" }, [
    { label: "ALPHA", get: (v) => v.a },
    { label: "BETA", get: (v) => v.b },
    { label: "C", get: (v) => v.c },
  ]);
  assertEquals(out, "ALPHA  1\nC      3");
});
