import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = resolve("dist/index.js");

async function run(cwd, args) {
  const result = await execFileAsync(process.execPath, [cli, ...args], { cwd });
  return JSON.parse(result.stdout);
}

test("session workflow builds an incremental receipt draft", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-session-"));

  const initResult = await run(cwd, [
    "init",
    "--session",
    "agent-a",
    "--currency",
    "EUR",
    "--document-number",
    "INV-001",
    "--card-par",
    "par-123"
  ]);
  const addResult = await run(cwd, [
    "add-product",
    "--session",
    "agent-a",
    "--name",
    "Nike Shoes",
    "--price-incl",
    "200",
    "--vat",
    "21"
  ]);
  const preview = await run(cwd, ["preview", "--session", "agent-a"]);

  await run(cwd, ["init", "--session", "agent-b", "--currency", "EUR", "--document-number", "INV-002"]);
  await run(cwd, ["add-product", "--session", "agent-b", "--name", "Socks", "--price-incl", "10", "--vat", "21"]);
  const otherPreview = await run(cwd, ["preview", "--session", "agent-b"]);

  assert.equal(initResult.sessionId, "agent-a");
  assert.equal(addResult.added.name, "Nike Shoes");
  assert.equal(addResult.added.unitPrice, 165.29);
  assert.equal(addResult.totals.totalAmount, 200);
  assert.equal(preview.identificationDetails.cardDetails.paymentAccountReference, "par-123");
  assert.equal(preview.receipt.products.length, 1);
  assert.equal(preview.receipt.taxes[0].amount, 34.71);
  assert.equal(otherPreview.receipt.documentNumber, "INV-002");
  assert.equal(otherPreview.receipt.products[0].name, "Socks");

  const rawSession = await readFile(join(cwd, ".cheqi/sessions/agent-a.json"), "utf8");
  assert.equal(JSON.parse(rawSession).receipt.documentNumber, "INV-001");
  const activeSession = await readFile(join(cwd, ".cheqi/active-session"), "utf8");
  assert.equal(activeSession.trim(), "agent-b");
});
