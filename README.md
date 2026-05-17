# Cheqi CLI

Agent-friendly CLI wrapper around `@cheqi/sdk`.

## Submit A Receipt

### Incremental Session Workflow

```bash
CHEQI_API_KEY=sk_test_... cheqi init --session agent-a --currency EUR --document-number INV-001
CHEQI_API_KEY=sk_test_... cheqi match --session agent-a --card-par YOUR_CARD_PAR

cheqi add-product \
  --session agent-a \
  --name "Nike Shoes" \
  --price-incl 200 \
  --vat 21

cheqi preview --session agent-a
CHEQI_API_KEY=sk_test_... cheqi finalize-receipt --session agent-a
```

Drafts are stored locally in `.cheqi/sessions/<session-id>.json`. The latest initialized or matched session is also written to `.cheqi/active-session`, so `--session` is optional for single-user flows. For multiple agents in the same working directory, pass a unique `--session` on every command.

You can also initialize with match details in one step when you do not need to call matching immediately:

```bash
cheqi init --session agent-a --currency EUR --document-number INV-001 --card-par YOUR_CARD_PAR
```

### Direct JSON Workflow

```bash
CHEQI_API_KEY=sk_test_... npx @cheqi/cli receipts submit \
  --match-by card_par \
  --match-value YOUR_CARD_PAR \
  --receipt receipt.json
```

The CLI performs matching, template generation, local encryption, and encrypted submission through the TypeScript SDK.

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

- `version`: the package version to publish, for example `0.1.1`
- `dist-tag`: `latest` or `next`

Before the CLI can be published, `@cheqi/sdk` must already exist on npm at a compatible version. Configure the repository secret `NPM_TOKEN` with publish access for the `@cheqi/cli` package.

```bash
npm view @cheqi/sdk@0.1.1 version
npm view @cheqi/cli@0.1.1 version
```
