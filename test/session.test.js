import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";

const execFileAsync = promisify(execFile);
const cli = resolve("dist/index.js");

async function run(cwd, args, options = {}) {
  const result = await execFileAsync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, ...options.env }
  });
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  return envelope.data;
}

async function runFailure(cwd, args, options = {}) {
  try {
    await execFileAsync(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, ...options.env }
    });
    assert.fail("expected command to fail");
  } catch (error) {
    const envelope = JSON.parse(error.stdout);
    assert.equal(envelope.ok, false);
    return envelope.error;
  }
}

test("agentic session workflow builds an incremental receipt draft", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-session-"));

  const initResult = await run(cwd, [
    "session",
    "create",
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
    "receipt",
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
  const validation = await run(cwd, ["receipt", "validate", "--session", "agent-a"]);
  const preview = await run(cwd, ["receipt", "preview", "--session", "agent-a"]);

  await run(cwd, ["session", "create", "--session", "agent-b", "--currency", "EUR", "--document-number", "INV-002"]);
  await run(cwd, ["receipt", "add-product", "--session", "agent-b", "--name", "Socks", "--price-incl", "10", "--vat", "21"]);
  const otherPreview = await run(cwd, ["receipt", "preview", "--session", "agent-b"]);

  assert.equal(initResult.sessionId, "agent-a");
  assert.deepEqual(initResult.nextStep.command, ["receipt", "add-product"]);
  assert.equal(addResult.added.name, "Nike Shoes");
  assert.equal(addResult.added.unitPrice, 165.29);
  assert.equal(addResult.totals.totalAmount, 200);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.nextStep.command, ["receipt", "finalize"]);
  assert.equal(preview.session.identificationDetails.cardDetails.paymentAccountReference, "par-123");
  assert.equal(preview.session.receipt.products.length, 1);
  assert.equal(preview.session.receipt.taxes[0].amount, 34.71);
  assert.equal(otherPreview.session.receipt.documentNumber, "INV-002");
  assert.equal(otherPreview.session.receipt.products[0].name, "Socks");

  const rawSession = await readFile(join(cwd, ".cheqi/sessions/agent-a.json"), "utf8");
  assert.equal(JSON.parse(rawSession).receipt.documentNumber, "INV-001");
});

test("errors are structured JSON envelopes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-error-"));
  const error = await runFailure(cwd, ["receipt", "preview", "--session", "missing"]);

  assert.equal(error.code, "SESSION_NOT_FOUND");
  assert.equal(error.retryable, false);
  assert.equal(error.details.sessionId, "missing");
});

test("empty identification details are accepted for download-link receipts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-empty-identification-"));

  const initResult = await run(cwd, [
    "session",
    "create",
    "--session",
    "download-link",
    "--currency",
    "EUR",
    "--document-number",
    "INV-DOWNLOAD",
    "--card-par",
    ""
  ]);
  await run(cwd, [
    "receipt",
    "add-product",
    "--session",
    "download-link",
    "--name",
    "Socks",
    "--price-incl",
    "10",
    "--vat",
    "21"
  ]);
  const validation = await run(cwd, ["receipt", "validate", "--session", "download-link"]);
  const preview = await run(cwd, ["receipt", "preview", "--session", "download-link"]);
  const status = await run(cwd, ["session", "status", "--session", "download-link"]);

  assert.equal(initResult.hasMatch, true);
  assert.deepEqual(initResult.nextStep.command, ["receipt", "add-product"]);
  assert.equal(validation.valid, true);
  assert.deepEqual(preview.session.identificationDetails, {});
  assert.equal(status.hasMatch, true);
  assert.deepEqual(status.nextStep.command, ["receipt", "validate"]);
});

test("empty session match stores empty identification details without calling matching", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-empty-match-"));
  await run(cwd, ["session", "create", "--session", "empty-match"]);

  const match = await run(cwd, [
    "session",
    "match",
    "--session",
    "empty-match",
    "--card-par",
    "",
    "--api-key",
    "sk_test_x"
  ]);
  const preview = await run(cwd, ["receipt", "preview", "--session", "empty-match"]);

  assert.equal(match.customerFound, false);
  assert.equal(match.recipientCount, 0);
  assert.deepEqual(preview.session.identificationDetails, {});
  assert.equal(preview.session.matchResponse, null);
});

test("finalize sends empty identification details to matching API for download fallback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-empty-finalize-"));
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ routeFound: false, customerFound: false, recipients: [] }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.equal(typeof address, "object");
  const endpoint = `http://127.0.0.1:${address.port}`;

  try {
    await run(cwd, [
      "session",
      "create",
      "--session",
      "empty-finalize",
      "--card-par",
      ""
    ]);
    await run(cwd, [
      "receipt",
      "add-product",
      "--session",
      "empty-finalize",
      "--name",
      "Socks",
      "--price-incl",
      "10",
      "--vat",
      "21"
    ]);
    const result = await run(cwd, [
      "receipt",
      "finalize",
      "--session",
      "empty-finalize",
      "--api-key",
      "sk_test_x",
      "--endpoint",
      endpoint,
      "--timeout",
      "2"
    ]);

    assert.equal(result.customerFound, false);
    assert.equal(requests[0].url, "/recipient/resolve");
    assert.deepEqual(requests[0].body, {});
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
});

test("schema is machine readable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-schema-"));
  const schema = await run(cwd, ["schema", "receipt", "validate"]);

  assert.equal(schema.commands.length, 1);
  assert.deepEqual(schema.commands[0].command, ["receipt", "validate"]);
  assert.equal(schema.commands[0].flags[0].name, "session");
  assert.equal(schema.commands[0].responseSchema.properties.valid.const, true);
});

test("schema includes positional arguments and response shapes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-schema-shape-"));
  const schema = await run(cwd, ["schema", "receipt", "add-product"]);
  const command = schema.commands[0];

  assert.deepEqual(command.command, ["receipt", "add-product"]);
  assert.equal(command.positional[0].name, "name");
  assert.equal(command.responseSchema.properties.added.type, "object");
  assert.equal(command.responseSchema.properties.nextStep.properties.command.type, "array");
});

test("subcommand help returns schema", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-help-"));
  const sessionSchema = await run(cwd, ["session", "--help"]);
  const submitSchema = await run(cwd, ["receipts", "submit", "--help"]);

  assert.deepEqual(sessionSchema.commands.map((command) => command.command[0]), ["session", "session", "session", "session"]);
  assert.deepEqual(submitSchema.commands[0].command, ["receipts", "submit"]);
});

test("auth error codes are structured", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-auth-"));
  const required = await runFailure(cwd, ["receipt", "finalize", "--session", "missing"]);
  const conflict = await runFailure(cwd, [
    "receipt",
    "finalize",
    "--session",
    "missing",
    "--api-key",
    "sk_test",
    "--access-token",
    "token"
  ]);

  assert.equal(required.code, "AUTH_REQUIRED");
  assert.equal(conflict.code, "AUTH_CONFLICT");
});

test("verbose mode keeps stdout pure JSON and routes SDK logs to stderr", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-verbose-"));
  await run(cwd, ["session", "create", "--session", "v1"]);

  // --verbose builds the SDK (which emits diagnostics). Point at an unreachable
  // endpoint so the request fails fast and deterministically.
  let stdout;
  let stderr;
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        cli,
        "session",
        "match",
        "--session",
        "v1",
        "--email",
        "a@b.com",
        "--verbose",
        "--endpoint",
        "http://127.0.0.1:1",
        "--api-key",
        "sk_test_x",
        "--timeout",
        "2"
      ],
      { cwd }
    );
    ({ stdout, stderr } = result);
  } catch (error) {
    ({ stdout, stderr } = error);
  }

  // stdout must remain a single parseable JSON envelope — no interleaved logs.
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.ok, false);
  // SDK diagnostics must appear on stderr, not stdout.
  assert.match(stderr, /CheqiSDK/);
  assert.doesNotMatch(stdout, /CheqiSDK/);
});

test("session create uses environment fallback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cheqi-cli-env-"));
  await run(cwd, ["session", "create", "--session", "env-session"], {
    env: { CHEQI_ENV: "test", CHEQI_API_ENDPOINT: "https://example.invalid" }
  });

  const rawSession = await readFile(join(cwd, ".cheqi/sessions/env-session.json"), "utf8");
  const session = JSON.parse(rawSession);
  assert.equal(session.auth.env, "test");
  assert.equal(session.auth.endpoint, "https://example.invalid");
});
