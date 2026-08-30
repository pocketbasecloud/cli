import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createProgress,
  formatElapsed,
  pauseProgress,
  plainProgress,
  renderLine,
  silentProgress,
  type Ticker,
} from "../../../src/ui/progress.ts";
import { type PromptIO, select } from "../../../src/ui/prompt.ts";

function harness(extra: Record<string, unknown> = {}) {
  const out: string[] = [];
  let ms = 0;
  let tick: (() => void) | null = null;
  const progress = createProgress({
    write: (s) => out.push(s),
    animate: true,
    unicode: true,
    columns: () => 80,
    now: () => ms,
    schedule: (fn): Ticker => {
      tick = fn;
      return { stop: () => (tick = null) };
    },
    ...extra,
  });
  return {
    progress,
    out,
    text: () => out.join(""),
    advance: (by: number) => (ms += by),
    tick: () => tick?.(),
    ticking: () => tick !== null,
  };
}

Deno.test("formatElapsed reads as seconds, then minutes and seconds", () => {
  assertEquals(formatElapsed(0), "0s");
  assertEquals(formatElapsed(5_400), "5s");
  assertEquals(formatElapsed(59_000), "59s");
  assertEquals(formatElapsed(65_000), "1m 05s");
  assertEquals(formatElapsed(600_000), "10m 00s");
});

Deno.test("renderLine shows elapsed time only once there is some", () => {
  assertEquals(renderLine("✓", "Packaged", 0), "✓ Packaged");
  assertEquals(renderLine("✓", "Packaged", 999), "✓ Packaged");
  assertEquals(renderLine("✓", "Packaged", 12_000), "✓ Packaged 12s");
});

Deno.test("renderLine truncates rather than wrapping the terminal", () => {
  const line = renderLine("⠋", "x".repeat(200), 0, 40);
  assertEquals(line.length, 39);
  assertStringIncludes(line, "…");
});

Deno.test("a plain step announces itself and reports when it is done", async () => {
  const lines: string[] = [];
  const progress = plainProgress((m) => lines.push(m));
  await progress.step("Uploading code.zip", (step) => {
    step.done("Uploaded code.zip");
    return Promise.resolve();
  });
  assertEquals(lines, ["→ Uploading code.zip…", "✓ Uploaded code.zip"]);
});

Deno.test("a plain step keeps its own wording when it does not reword", async () => {
  const lines: string[] = [];
  await plainProgress((m) => lines.push(m)).step("Packaging files", () => {
    return Promise.resolve();
  });
  assertEquals(lines, ["→ Packaging files…", "✓ Packaging files"]);
});

Deno.test("a plain step reports each change of wording on its own line", async () => {
  const lines: string[] = [];
  await plainProgress((m) => lines.push(m)).step("Creating api", (step) => {
    step.update("Creating api — creating");
    step.update("Creating api — creating");
    step.update("Creating api — running");
    step.done("api is running");
    return Promise.resolve();
  });
  assertEquals(lines, [
    "→ Creating api…",
    "→ Creating api — creating…",
    "→ Creating api — running…",
    "✓ api is running",
  ]);
});

Deno.test("a failing step is marked failed and the error still propagates", async () => {
  const lines: string[] = [];
  const progress = plainProgress((m) => lines.push(m));
  const err = await progress.step("Uploading", () => {
    return Promise.reject(new Error("boom"));
  }).catch((e: Error) => e);
  assertEquals(err.message, "boom");
  assertEquals(lines[1], "✗ Uploading");
});

Deno.test("an animated step redraws a frame on every tick", () => {
  const h = harness();
  const step = h.progress.start("Uploading code.zip");
  h.advance(12_000);
  h.tick();
  const drawn = h.text();
  assertStringIncludes(drawn, "\r\x1b[2K");
  assertStringIncludes(drawn, "⠙ Uploading code.zip 12s");
  step.done("Uploaded code.zip");
  assertStringIncludes(h.text(), "✓ Uploaded code.zip 12s\n");
  assertEquals(h.ticking(), false);
});

Deno.test("update changes what the animation says without closing it", () => {
  const h = harness();
  const step = h.progress.start("Creating api");
  step.update("Creating api — provisioning");
  assertStringIncludes(h.text(), "Creating api — provisioning");
  step.done();
  assertStringIncludes(h.text(), "✓ Creating api — provisioning");
});

Deno.test("a log during an animated step never lands inside the frame", () => {
  const h = harness();
  const step = h.progress.start("Uploading");
  h.out.length = 0;
  h.progress.log("Subdomain taken — using web-2.");
  const written = h.text();
  assertEquals(written.startsWith("\r\x1b[2K"), true);
  assertStringIncludes(written, "Subdomain taken — using web-2.\n");
  assertEquals(written.trimEnd().endsWith("⠋ Uploading"), true);
  assertEquals(h.ticking(), true);
  step.done();
});

Deno.test("pauseProgress gives the line back to a prompt and takes it again", async () => {
  const h = harness();
  const step = h.progress.start("Choosing a compute");
  assertEquals(h.ticking(), true);
  h.out.length = 0;
  await pauseProgress(() => {
    assertEquals(h.ticking(), false, "no frames may land on a prompt");
    assertEquals(h.text(), "\r\x1b[2K", "the prompt gets a cleared line");
    return Promise.resolve();
  });
  assertEquals(h.ticking(), true);
  step.done();
});

Deno.test("pauseProgress is a no-op when nothing is animating", async () => {
  assertEquals(await pauseProgress(() => Promise.resolve(7)), 7);
});

Deno.test("a prompt asked from inside a step is not drawn over", async () => {
  const h = harness();
  const step = h.progress.start("Uploading code.zip");
  const io: PromptIO = {
    read: () => {
      assertEquals(h.ticking(), false, "frames must stop while asking");
      return Promise.resolve("2");
    },
    write: () => {},
    isTTY: true,
  };
  const picked = await select("Which compute?", ["a", "b"], (x) => x, {
    noInput: false,
    io,
  });
  assertEquals(picked, "b");
  assertEquals(h.ticking(), true, "the step resumes once the answer is in");
  step.done();
});

Deno.test("two animated steps at once do not draw over each other", () => {
  const h = harness();
  const outer = h.progress.start("Deploying");
  const inner = h.progress.start("Uploading");
  h.out.length = 0;
  h.tick();
  assertStringIncludes(h.text(), "Uploading");
  assertEquals(h.text().includes("Deploying"), false);
  inner.done();
  outer.done();
  assertStringIncludes(h.text(), "✓ Deploying");
});

Deno.test("ASCII marks stand in where braille would not render", async () => {
  const lines: string[] = [];
  const progress = createProgress({
    animate: false,
    unicode: false,
    write: (s) => lines.push(s.replace(/\n$/, "")),
  });
  await progress.step("Packaging", () => Promise.resolve());
  assertEquals(lines, ["> Packaging…", "+ Packaging"]);
});

Deno.test("a silent progress writes nothing at all", async () => {
  const progress = silentProgress();
  const lines: string[] = [];
  const original = console.log;
  console.log = (m: string) => lines.push(m);
  try {
    progress.log("nothing");
    await progress.step("Uploading", (s) => {
      s.update("still nothing");
      return Promise.resolve();
    });
  } finally {
    console.log = original;
  }
  assertEquals(lines, []);
});

Deno.test("--json silences the deploy's progress entirely", async () => {
  const written: string[] = [];
  const progress = createProgress({
    silent: true,
    animate: true,
    write: (s) => written.push(s),
  });
  progress.log("Packaged 12 files.");
  await progress.step("Uploading", () => Promise.resolve());
  assertEquals(written, []);
});

Deno.test("the default writer targets stderr, never stdout — --json's one JSON object on stdout must never see a spinner frame", () => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = Deno.stdout.writeSync;
  const origStderr = Deno.stderr.writeSync;
  const dec = new TextDecoder();
  Deno.stdout.writeSync = (b: Uint8Array) => {
    stdoutChunks.push(dec.decode(b));
    return b.byteLength;
  };
  Deno.stderr.writeSync = (b: Uint8Array) => {
    stderrChunks.push(dec.decode(b));
    return b.byteLength;
  };
  try {
    const progress = createProgress({ animate: false });
    progress.log("a status line");
  } finally {
    Deno.stdout.writeSync = origStdout;
    Deno.stderr.writeSync = origStderr;
  }
  assertEquals(stdoutChunks, []);
  assertStringIncludes(stderrChunks.join(""), "a status line");
});
