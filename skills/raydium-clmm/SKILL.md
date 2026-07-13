---
name: raydium-clmm
description: Interact with Raydium CLMM pools and positions using the Raydium CLI. Use this skill for CLMM pool creation, opening positions, increasing/decreasing liquidity, collecting fees, and closing positions.
---

# Raydium CLMM

Use this skill for concentrated liquidity workflows (`raydium clmm ...`).

## Prerequisite

Run `agent-setup-and-wallet` first.

---

## View Commands

### Pool state

```bash
raydium --json clmm pool <pool-id>
```

### Initialized ticks

```bash
raydium --json clmm ticks <pool-id> [--min-tick <tick>] [--max-tick <tick>] [--limit <number>]
```

### Wallet positions

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --password-stdin clmm positions [--wallet <name>]
```

### Single position details

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --password-stdin clmm position <nft-mint>
```

---

## Manage Liquidity

### Open position

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --password-stdin clmm open-position \
  --pool-id <address> \
  --price-lower <number> \
  --price-upper <number> \
  --amount <number> \
  [--token A|B] \
  [--slippage <percent>] \
  [--priority-fee <sol>] \
  [--auto-swap]
```

### Increase liquidity

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --password-stdin clmm increase-liquidity \
  --nft-mint <address> \
  --amount <number> \
  [--token A|B] \
  [--slippage <percent>] \
  [--priority-fee <sol>] \
  [--auto-swap]
```

### Decrease liquidity

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --password-stdin clmm decrease-liquidity \
  --nft-mint <address> \
  --percent <number> \
  [--slippage <percent>] \
  [--priority-fee <sol>] \
  [--swap-to-sol]
```

### Collect fees

```bash
# Single position
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --password-stdin clmm collect-fees \
  --nft-mint <address> \
  [--priority-fee <sol>]

# All positions
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --password-stdin clmm collect-fees \
  --all \
  [--priority-fee <sol>]
```

### Close position

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --password-stdin clmm close-position \
  --nft-mint <address> \
  [--force] \
  [--slippage <percent>] \
  [--priority-fee <sol>]
```

---

## Create CLMM Pool

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --password-stdin clmm create-pool \
  --mint-a <address> \
  --mint-b <address> \
  --fee-tier <bps> \
  --initial-price <number> \
  [--priority-fee <sol>]
```

---

## Agent Execution Rules

1. Do not be exploratory when a command is already specified in this skill.
2. Run the canonical command first; do not run `--help` unless the user asks or execution fails due to invalid args.
3. Any CLMM command that reads wallet-owned positions or signs transactions must include password auth (`--password-stdin` or `--password`).
4. Use the active wallet by default; only set `--wallet`/`--keystore` if user asks.
5. Validate required flags before execution and ask for missing inputs.
6. Return tx signatures and summarize action + key parameters.
