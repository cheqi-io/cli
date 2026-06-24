# Cheqi CLI

Agent-friendly CLI wrapper around `@cheqi/sdk`.

Every command returns a JSON envelope on stdout:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "durationMs": 12,
    "version": "0.2.0"
  }
}
```

Failures use the same shape and include stable error codes:

```json
{
  "ok": false,
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "No Cheqi session found for agent-a. Run cheqi session create --session agent-a first.",
    "retryable": false,
    "details": {
      "sessionId": "agent-a"
    }
  },
  "meta": {
    "durationMs": 4,
    "version": "0.2.0"
  }
}
```

## Incremental Session Workflow

```bash
cheqi session create \
  --session agent-a \
  --currency EUR \
  --document-number INV-001 \
  --card-par YOUR_CARD_PAR

cheqi receipt add-product \
  --session agent-a \
  --name "Nike Shoes" \
  --price-incl 200 \
  --vat 21

cheqi receipt validate --session agent-a
cheqi receipt preview --session agent-a
CHEQI_API_KEY=sk_test_... cheqi receipt finalize --session agent-a
```

Drafts are stored locally in `.cheqi/sessions/<session-id>.json`. Sessions are always explicit; pass `--session` on every command so concurrent agents do not share implicit state.

To call the Cheqi matching service before adding products:

```bash
CHEQI_API_KEY=sk_test_... cheqi session match \
  --session agent-a \
  --card-par YOUR_CARD_PAR
```

## Direct JSON Workflow

```bash
CHEQI_API_KEY=sk_test_... npx @cheqi/cli receipts submit \
  --match-by card_par \
  --match-value YOUR_CARD_PAR \
  --receipt receipt.json
```

Use `--receipt -` to read the receipt JSON from stdin.

## Machine-Readable Schema

Agents can discover commands, flags, valid enum values, and response names without parsing human help text:

```bash
cheqi schema
cheqi schema receipt validate
cheqi receipt add-product --help
```

Schema entries include `flags`, `positional`, and `responseSchema` so an agent can construct commands and validate expected output without probing the command first.

Operational responses include a structured `nextStep` when another command is expected:

```json
{
  "command": ["receipt", "validate"],
  "requiredFlags": ["session"],
  "optionalFlags": [],
  "hint": "Validate locally before finalizing."
}
```

## Authentication

Use either:

```bash
CHEQI_API_KEY=sk_test_...
```

or:

```bash
CHEQI_ACCESS_TOKEN=...
```

Do not set both for the same command.

## Publishing

The GitHub Actions `Publish npm package` workflow publishes `@cheqi/cli` to npm. Run it manually with:

- `version`: the package version to publish, for example `0.2.0`
- `dist-tag`: `latest` or `next`

Before the CLI can be published, `@cheqi/sdk` must already exist on npm at a compatible version. Configure the repository secret `NPM_TOKEN` with publish access for the `@cheqi/cli` package.

```bash
npm view @cheqi/sdk@0.1.1 version
npm view @cheqi/cli@0.2.0 version
```
