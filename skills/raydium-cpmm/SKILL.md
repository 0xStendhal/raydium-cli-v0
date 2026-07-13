---
name: raydium-cpmm
description: Inspect Raydium CPMM pools and produce or execute guarded direct CPMM swaps with the Raydium CLI.
---

# Raydium CPMM

Use this skill for current CPMM workflows supported by `raydium cpmm ...`.

## Prerequisite

Run `agent-setup-and-wallet` first.

---

## Supported Commands (Current)

### Inspect CPMM state and fee configs

```bash
raydium --json cpmm configs [--devnet]
raydium --json cpmm pool <pool-id>
```

Pool inspection prefers decoded RPC state. If the installed SDK cannot decode the pool's on-chain layout, it returns explicitly labeled `source: raydium-api` indexed data instead. That fallback may be stale and must never be used to quote or execute a transaction.

### Quote a direct CPMM swap

```bash
raydium --json cpmm swap \
  --pool-id <address> \
  --input-mint <address> \
  --amount <number> \
  [--slippage <percent>]
```

For exact output, `--amount` is the requested output and `--output-mint` is required instead of `--input-mint`:

```bash
raydium --json cpmm swap \
  --pool-id <address> \
  --exact-out \
  --output-mint <address> \
  --amount <number>
```

### Execute a direct CPMM swap

```bash
QUOTE_ID="$(raydium --json cpmm swap \
  --pool-id <address> \
  --input-mint <address> \
  --amount <number> | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).quoteId')"

printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --password-stdin cpmm swap \
  --execute \
  --pool-id <address> \
  --input-mint <address> \
  --amount <number> \
  --approve-quote "$QUOTE_ID"
```

The CLI refreshes the quote, builds one V0 transaction, validates its signer/payer, address lookups, and allowed top-level programs, then simulates it locally and sends it only after confirmation. Quotes include the enforced minimum output or maximum input; price can still move before the transaction lands. It rejects slippage above 5% and priority fees above 0.01 SOL unless the matching `--allow-high-*` flag is supplied, and always rejects priority fees above 0.1 SOL.

### Quote or manage proportional liquidity

```bash
raydium --json cpmm liquidity add \
  --pool-id <address> \
  --input-mint <address> \
  --amount <number> \
  [--slippage <percent>]

raydium --json cpmm liquidity remove \
  --pool-id <address> \
  --lp-amount <number> \
  [--slippage <percent>]
```

Add `--execute` only after the quote has been approved. JSON executions require `--approve-quote <quoteId>` from the matching fresh quote. Deposit quotes report the other token currently required and minimum LP tokens minted. Withdrawal quotes report minimum receipts after the SDK's supported Token-2022 transfer-fee calculation.

## Not Yet Implemented In This CLI

The following CPMM workflows are planned for future versions and are not currently exposed as `raydium cpmm` commands:

1. Create CPMM pool
2. General multi-pool routing inside `cpmm`

When asked for one of these, clearly state it is not yet available in the current CLI and avoid fabricating commands.

---

## Agent Execution Rules

1. Default to a quote; add `--execute` only when a transaction is intended.
2. For automation, quote with `--json`, enforce a policy against the quote and `quoteId`, then use `--json --yes --password-stdin --approve-quote <quoteId>` only for the approved execution.
3. Use the active wallet by default.
4. Validate the pool and mint side before execution.
5. Return the transaction signature and the final refreshed quote.
6. Do not run exploratory `--help` checks before the canonical command unless user asks.
