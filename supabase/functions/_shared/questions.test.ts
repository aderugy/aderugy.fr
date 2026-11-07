import { test } from "node:test";
import assert from "node:assert/strict";
import { questionFor } from "./questions.ts";

test("names the project, opens its thread, strips Markdown", () => {
  const r = questionFor({
    id: "3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b",
    slug: "MAD",
    body: "## Cut line\n- On passe **2.1** à 4h00 ?\n- Ou on coupe ici",
  });
  assert.equal(r.title, "MAD · question de Claude");
  assert.equal(r.body, "Cut line\nOn passe 2.1 à 4h00 ?\nOu on coupe ici");
  assert.equal(r.tag, "question-3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b");
  assert.equal(r.url, "/projects/MAD#messages");
});

test("long questions are cut for the lock screen", () => {
  const r = questionFor({ id: "x", slug: "MAD", body: "a".repeat(400) });
  assert.equal(r.body.length, 180);
  assert.ok(r.body.endsWith("…"));
});
