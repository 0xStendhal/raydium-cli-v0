---
name: raydium-launchpad
description: Create Raydium Launchpad tokens and trade them (buy/sell) using the Raydium CLI. Use this skill when an agent needs to create a launchpad platform, launch a token, trade against the bonding curve pool, or manage launchpad fees.
---

# Raydium Launchpad (Create Tokens + Buy/Sell)

Raydium Launchpad lets you create a token with a bonding curve pool and trade it immediately (buy/sell). This skill uses the Raydium CLI, which wraps the SDK and handles signing, configuration, and transaction building.

## Prerequisite

Run `agent-setup-and-wallet` first for one-time CLI install, config defaults, and wallet setup.

---

## Commands

### configs

List available launchpad configurations (quote tokens, fee tiers, defaults).

```bash
raydium --json launchpad configs
```

No options.

---

### platforms

List LaunchLab platforms.

```bash
raydium --json launchpad platforms
```

| Flag | Description | Default |
|------|-------------|---------|
| `--limit <number>` | Max results | 20 |
| `--page <number>` | Page number | 1 |

---

### info

Get launchpad pool info (status, price, progress, vesting).

```bash
raydium --json launchpad info --mint <address>
raydium --json launchpad info --pool <address>
```

| Flag | Description | Default |
|------|-------------|---------|
| `--mint <address>` | Token mint address (derives pool) | — |
| `--pool <address>` | Direct pool address | — |
| `--usd1` | Use USD1 as quote token instead of SOL (only with --mint) | false |

Must specify either `--mint` or `--pool`, not both.

---

### buy

Buy tokens from a launchpad bonding curve. `--amount` is how much quote token (SOL/USDC/USD1) to spend. The pool is auto-detected.

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --keystore my-wallet --password-stdin \
    launchpad buy \
    --mint <token-mint> \
    --amount 0.5
```

| Flag | Description | Default |
|------|-------------|---------|
| `--mint <address>` | **(required)** Token mint address | — |
| `--amount <number>` | **(required)** Amount of quote token to spend | — |
| `--slippage <percent>` | Slippage tolerance | config default |
| `--priority-fee <sol>` | Priority fee in SOL | config default |
| `--debug` | Print full error on failure | false |

---

### sell

Sell tokens back to a launchpad bonding curve. `--amount` is how many tokens to sell. The pool is auto-detected.

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --keystore my-wallet --password-stdin \
    launchpad sell \
    --mint <token-mint> \
    --amount 1000
```

| Flag | Description | Default |
|------|-------------|---------|
| `--mint <address>` | **(required)** Token mint address | — |
| `--amount <number>` | **(required)** Amount of tokens to sell | — |
| `--slippage <percent>` | Slippage tolerance | config default |
| `--priority-fee <sol>` | Priority fee in SOL | config default |
| `--debug` | Print full error on failure | false |

---

### create-platform

Create a new launchpad platform configuration. Each wallet can only create one platform. The command returns a Platform ID to use when launching tokens.

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --keystore my-wallet --password-stdin \
    launchpad create-platform \
    --name "My Platform" \
    --fee-rate 100 \
    --creator-fee-rate 50 \
    --platform-scale 50 \
    --creator-scale 50 \
    --burn-scale 0
```

| Flag | Description | Default |
|------|-------------|---------|
| `--name <string>` | **(required)** Platform name | — |
| `--fee-rate <bps>` | Platform fee in basis points (100 = 1%) | 100 |
| `--creator-fee-rate <bps>` | Creator fee in basis points (50 = 0.5%) | 50 |
| `--platform-scale <percent>` | Platform LP % on migration | 50 |
| `--creator-scale <percent>` | Creator LP % on migration | 50 |
| `--burn-scale <percent>` | Burn LP % on migration | 0 |
| `--web <url>` | Platform website URL | — |
| `--img <url>` | Platform logo image URL | — |
| `--priority-fee <sol>` | Priority fee in SOL | config default |
| `--debug` | Print full error on failure | false |

Notes:
- `--platform-scale` + `--creator-scale` + `--burn-scale` must sum to 100.
- If you get "account already in use", your wallet already has a platform. Use that Platform ID or switch wallets.

---

### create

Launch a new token with a bonding curve pool. Must provide either `--image` (local file, auto-uploads to IPFS) or `--uri` (pre-hosted metadata).

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --keystore my-wallet --password-stdin \
    launchpad create \
    --platform-id <address> \
    --name "My Token" \
    --symbol "MTK" \
    --image ./logo.png \
    --description "My awesome token"
```

| Flag | Description | Default |
|------|-------------|---------|
| `--platform-id <address>` | **(required)** Platform config address | — |
| `--name <string>` | **(required)** Token name | — |
| `--symbol <string>` | **(required)** Token symbol | — |
| `--image <path>` | Path to token image (uploads to IPFS) | — |
| `--uri <string>` | Token metadata URI (use instead of --image) | — |
| `--description <string>` | Token description | — |
| `--twitter <url>` | Twitter URL | — |
| `--telegram <url>` | Telegram URL | — |
| `--website <url>` | Website URL | — |
| `--config-id <address>` | Launchpad config ID | auto-detected |
| `--decimals <number>` | Token decimals | 6 |
| `--buy-amount <sol>` | Initial SOL to buy (optional dev buy) | — |
| `--slippage <percent>` | Slippage for initial buy | 1 |
| `--priority-fee <sol>` | Priority fee in SOL | config default |
| `--debug` | Print full error on failure | false |

Notes:
- Either `--image` or `--uri` is required.
- `--image` requires `pinata-jwt` to be configured.
- A new mint keypair is generated automatically.
- If `--config-id` is omitted, the CLI auto-selects a SOL quote config.

Output:
- `mintAddress` — the token mint
- `poolId` — the launchpad pool
- `txId` — transaction signature

---

### fee-balance

Check platform fee balances available to claim.

```bash
raydium --json launchpad fee-balance --platform-id <address>
```

| Flag | Description | Default |
|------|-------------|---------|
| `--platform-id <address>` | **(required)** Platform config address | — |
| `--mint-b <address>` | Quote token mint | checks SOL, USD1, USDC |

---

### claim-fees

Claim platform fees from launchpad.

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --keystore my-wallet --password-stdin \
    launchpad claim-fees \
    --platform-id <address>
```

| Flag | Description | Default |
|------|-------------|---------|
| `--platform-id <address>` | **(required)** Platform config address | — |
| `--mint-b <address>` | Quote token mint | SOL |
| `--priority-fee <sol>` | Priority fee in SOL | config default |
| `--debug` | Print full error on failure | false |

---

### creator-fee-balance

Check your creator fee balances available to claim.

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --keystore my-wallet --password-stdin \
    launchpad creator-fee-balance
```

| Flag | Description | Default |
|------|-------------|---------|
| `--mint-b <address>` | Quote token mint | checks SOL, USD1, USDC |

---

### claim-creator-fees

Claim creator fees accumulated from your launchpad tokens.

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --keystore my-wallet --password-stdin \
    launchpad claim-creator-fees
```

| Flag | Description | Default |
|------|-------------|---------|
| `--mint-b <address>` | Quote token mint | SOL |
| `--priority-fee <sol>` | Priority fee in SOL | config default |
| `--debug` | Print full error on failure | false |

---

## Typical Workflow

1. **Set up wallet** — create/import, fund with SOL
2. **Create platform** — `create-platform` (one-time per wallet)
3. **Launch token** — `create` with your platform ID
4. **Trade** — `buy` / `sell` using the mint address
5. **Check fees** — `fee-balance` / `creator-fee-balance`
6. **Claim fees** — `claim-fees` / `claim-creator-fees`

## Tips

- Use a dedicated wallet for launches and keep balances minimal.
- Start with a small `--buy-amount` and conservative slippage.
- Ensure your RPC is reliable; launch transactions are multi-step.
- Keep the Platform ID and Mint Address for future actions.

## Agent Execution Rule

For wallet-dependent launchpad commands (`buy`, `sell`, `create-platform`, `create`, `claim-fees`, `creator-fee-balance`, `claim-creator-fees`), include password auth on the first attempt (`--password-stdin` preferred).
