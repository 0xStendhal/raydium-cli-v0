---
name: raydium-swap
description: Swap tokens on Raydium using the Raydium CLI. Use this skill when an agent needs to execute a token swap by auto-routing with the Trade API or by swapping directly through a specific AMM pool.
---

# Raydium Swap

Use this skill to run the existing `raydium swap` command.

## Prerequisite

Run `agent-setup-and-wallet` first for one-time CLI install, config defaults, and wallet setup.

---

## Command

```bash
raydium swap --input-mint <mint> --amount <number> [options]
```

The command supports two modes:

1. Auto-route mode (recommended): omit `--pool-id` and provide `--output-mint`.
2. Direct pool mode: provide `--pool-id` and `--input-mint` (optional `--output-mint`).

---

## Required Inputs

Always required:
- `--input-mint <mint>`
- `--amount <number>`

Conditionally required:
- `--output-mint <mint>` is required when `--pool-id` is not provided.

An active wallet is required only with `--execute`. Quotes do not decrypt a wallet or send a transaction.

---

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--pool-id <pool>` | AMM pool address (omit for auto-routing) | auto-route mode |
| `--input-mint <mint>` | Input token mint | required |
| `--amount <number>` | Amount to swap | required |
| `--output-mint <mint>` | Output token mint (required for auto-route mode) | required if no `--pool-id` |
| `--exact-out` | Treat `--amount` as requested output (auto-route only) | false |
| `--execute` | Build, simulate, review, and send the quoted swap | false |
| `--approve-quote <quote-id>` | Required with `--json --execute`; use `quoteId` from a fresh quote | unset |
| `--slippage <percent>` | Slippage tolerance | config `default-slippage` |
| `--priority-fee <sol>` | Priority fee in SOL | config `priority-fee` |
| `--debug` | Print full error object on failure | false |

Useful global flags for agents:
- `--json`
- `--yes`
- `--keystore <name>`
- `--password <value>` or `--password-stdin`

---

## Examples

### Auto-route quote (recommended)

```bash
raydium --json swap \
  --input-mint So11111111111111111111111111111111111111112 \
  --output-mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --amount 0.1 \
  --slippage 0.5 \
  --priority-fee 0.000005
```

### Approved execution

```bash
QUOTE_ID="$(raydium --json swap \
  --input-mint So11111111111111111111111111111111111111112 \
  --output-mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --amount 0.1 \
  --slippage 0.5 | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).quoteId')"

printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --keystore my-wallet --password-stdin \
  swap \
  --execute \
  --input-mint So11111111111111111111111111111111111111112 \
  --output-mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --amount 0.1 \
  --slippage 0.5 \
  --approve-quote "$QUOTE_ID"
```

### Direct pool execution

```bash
QUOTE_ID="$(raydium --json swap \
  --pool-id <pool-address> \
  --input-mint <input-mint> \
  --amount 10 \
  --slippage 0.5 | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).quoteId')"

printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --keystore my-wallet --password-stdin \
  swap --execute \
  --pool-id <pool-address> \
  --input-mint <input-mint> \
  --amount 10 \
  --slippage 0.5 \
  --approve-quote "$QUOTE_ID"
```

---

## Output

JSON mode:
- Quote mode returns the route or pool estimate, its enforced threshold, and `quoteId`.
- Execution returns one confirmed `txId`, the final refreshed quote, transaction review, and simulation units.
- Execution JSON also includes `explorerUrl`; interactive users can decline the post-confirmation browser prompt.

Text mode:
- Prints submitted transaction signature(s).

---

## Agent Execution Pattern

1. Validate user intent includes input mint, amount, and either output mint (auto-route) or pool id (direct).
2. Run a `--json` quote first and enforce a policy against its threshold, price impact, route, and `quoteId`.
3. Run the matching `--execute` command with `--json --yes`, `--approve-quote <quoteId>`, and password auth only after approval (`--password-stdin` preferred).
4. Return the confirmed transaction signature and the final refreshed quote.
5. Do not run exploratory `--help` checks before the canonical swap command unless user asks.
