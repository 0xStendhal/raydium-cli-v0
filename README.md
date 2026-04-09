# Raydium CLI

CLI tool for interacting with Raydium on Solana -- swap, manage CLMM/CPMM positions, launch tokens, and more.

## Install

```
npm install -g @zoidz123/raydium-cli
```

## Install Skills (Codex or Claude)

Copy the Raydium skills into your agent's local skills directory.

For Codex:

```bash
mkdir -p ~/.codex/skills
git clone https://github.com/zoidz123/raydium-cli.git /tmp/raydium-cli
cp -R /tmp/raydium-cli/skills/* ~/.codex/skills/
```

For Claude Code:

```bash
mkdir -p ~/.claude/skills
git clone https://github.com/zoidz123/raydium-cli.git /tmp/raydium-cli
cp -R /tmp/raydium-cli/skills/* ~/.claude/skills/
```

## Quick Start

```bash
raydium config init          # interactive setup (RPC URL, slippage, explorer, priority fee)
raydium wallet create main   # create an encrypted wallet
raydium --help               # see all commands
```

All commands support `--json` for machine-readable JSON output. For scripting or agent use, add `--yes` to auto-confirm prompts and `--password-stdin` (or `--password <value>`) for wallet commands.

## Configuration

Config is stored at `~/.raydium-cli/config.json`.

```bash
raydium config init                           # interactive setup wizard
raydium config set rpc-url <url>              # set RPC endpoint
raydium config set default-slippage 0.5       # set default slippage (%)
raydium config set priority-fee 0.000005      # set default priority fee (SOL)
raydium config set explorer solscan           # solscan | solanaFm | solanaExplorer
raydium config set pinata-jwt <jwt>           # set Pinata JWT for IPFS uploads
raydium config get                            # show all config
raydium config get rpc-url                    # show single value
```

## Wallets

Wallets are stored at `~/.raydium-cli/wallets/` and encrypted with AES-256-GCM (PBKDF2 key derivation).

```bash
raydium wallet create [name]                          # generate new wallet (shows seed phrase once)
raydium wallet import <name> --private-key <base58>   # import from private key
raydium wallet import <name> --seed-phrase "<phrase>"  # import from seed phrase
raydium wallet list                                   # list all wallets
raydium wallet use <name>                             # set active wallet
raydium wallet balance [name]                         # show SOL + token balances
raydium wallet export <name>                          # reveal private key (requires confirmation)
```

## Agent Password Setup (Human Step)

For agent automation, use one shared wallet password across your wallets, and select the active wallet with `raydium wallet use <name>`.

Create a local `.env` file from `.env.example` (do not commit it):

```bash
cp .env.example .env
```

```bash
RAYDIUM_WALLET_PASSWORD="your-wallet-password"
```

Load it into the same shell/session where your agent commands run, so the agent process can inherit `RAYDIUM_WALLET_PASSWORD`:

```bash
set -a; source .env; set +a
```

Then run signing commands with `--password-stdin` (active wallet is used by default):

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --password-stdin swap \
  --input-mint <mint> \
  --output-mint <mint> \
  --amount <number>
```

## Swap

Supports both direct AMM pool swaps and auto-routed swaps via the Raydium Trade API.

```bash
# Auto-routed swap (recommended -- finds best route automatically)
raydium swap --input-mint <mint> --output-mint <mint> --amount 1

# Direct pool swap
raydium swap --pool-id <pool> --input-mint <mint> --amount 1

# With options
raydium swap --input-mint <mint> --output-mint <mint> --amount 1 \
  --slippage 0.5 --priority-fee 0.000005 --debug
```

## Pools

```bash
raydium pools list                                    # list all pools
raydium pools list --type concentrated --limit 20     # filter by type
raydium pools list --mint-a <mint> --mint-b <mint>    # filter by token pair
```

## CLMM (Concentrated Liquidity)

### View Pool & Position Data

```bash
raydium clmm pool <pool-id>                           # show pool state, price, TVL, fees
raydium clmm ticks <pool-id>                          # list initialized ticks with liquidity
raydium clmm ticks <pool-id> --min-tick -100 --max-tick 100 --limit 20
raydium clmm positions                                # list all positions for active wallet
raydium clmm positions --wallet <name>                # list positions for specific wallet
raydium clmm position <nft-mint>                      # detailed view of a single position
```

### Manage Positions

```bash
# Open a new position
raydium clmm open-position \
  --pool-id <address> \
  --price-lower 0.95 \
  --price-upper 1.05 \
  --amount 100 \
  --token A \
  --slippage 0.5 \
  --auto-swap              # swap to get required token ratio if needed

# Add liquidity to existing position
raydium clmm increase-liquidity \
  --nft-mint <address> \
  --amount 50 \
  --token A \
  --auto-swap

# Remove liquidity
raydium clmm decrease-liquidity \
  --nft-mint <address> \
  --percent 50 \
  --slippage 0.5 \
  --swap-to-sol            # optionally swap withdrawn tokens to SOL

# Collect accumulated fees
raydium clmm collect-fees --nft-mint <address>
raydium clmm collect-fees --all                       # collect from all positions with fees

# Close a position (must have zero liquidity, or use --force)
raydium clmm close-position --nft-mint <address>
raydium clmm close-position --nft-mint <address> --force   # removes liquidity first
```

### Create a Pool

```bash
raydium clmm create-pool \
  --mint-a <address> \
  --mint-b <address> \
  --fee-tier 2500 \
  --initial-price 1.0
```

## CPMM (Constant Product)

Note: current `raydium cpmm` command set covers fee/config workflows only.
Pool creation and general liquidity management are not yet exposed as CLI commands.

### View Configs

```bash
raydium cpmm configs                                  # list available fee tier configurations
raydium cpmm configs --devnet                         # devnet configs
```

### Manage Fees

```bash
# Collect creator fees from a pool you created
raydium cpmm collect-creator-fees --pool-id <address>

# Harvest fees from a locked LP position
raydium cpmm harvest-lp-fees \
  --pool-id <address> \
  --nft-mint <address> \
  --percent 100
```

## Launchpad

### Browse

```bash
raydium launchpad configs                              # list available launchpad configurations
raydium launchpad platforms --limit 20 --page 1        # list LaunchLab platforms
raydium launchpad info --mint <address>                # get pool info by token mint
raydium launchpad info --pool <address>                # get pool info by pool address
raydium launchpad info --mint <address> --usd1         # use USD1 as quote token
```

### Buy & Sell

```bash
# Buy tokens from a bonding curve
raydium launchpad buy \
  --mint <token-mint> \
  --amount 0.5 \
  --slippage 1 \
  --priority-fee 0.000005

# Sell tokens back
raydium launchpad sell \
  --mint <token-mint> \
  --amount 1000 \
  --slippage 1
```

### Launch a Token

```bash
# Create a platform first (or use an existing platform ID)
raydium launchpad create-platform \
  --name "My Platform" \
  --fee-rate 100 \
  --creator-fee-rate 50 \
  --platform-scale 50 \
  --creator-scale 50 \
  --burn-scale 0 \
  --web "https://example.com" \
  --img "https://example.com/logo.png"

# Launch a token
raydium launchpad create \
  --platform-id <address> \
  --name "My Token" \
  --symbol "MTK" \
  --image ./logo.png \
  --description "My awesome token" \
  --twitter "https://twitter.com/mytoken" \
  --website "https://mytoken.com" \
  --buy-amount 0.1            # optional initial dev buy
```

### Claim Fees

```bash
# Check platform fee balances
raydium launchpad fee-balance --platform-id <address>
raydium launchpad fee-balance --platform-id <address> --mint-b <quote-mint>

# Claim platform fees
raydium launchpad claim-fees --platform-id <address>

# Check creator fee balances
raydium launchpad creator-fee-balance
raydium launchpad creator-fee-balance --mint-b <quote-mint>

# Claim creator fees
raydium launchpad claim-creator-fees
raydium launchpad claim-creator-fees --mint-b <quote-mint>
```

## Global Options

| Flag | Description |
|------|-------------|
| `--json` | Output JSON instead of formatted text |
| `--debug` | Print full error details on failure |
| `--yes` | Auto-confirm prompts |
| `--password <value>` | Wallet password (discouraged; prefer `--password-stdin`) |
| `--password-stdin` | Read wallet password from stdin |
| `--keystore <name-or-path>` | Wallet name or path to wallet file |

Command-specific flags such as `--priority-fee` and `--slippage` are available only on commands that define them (for example `swap`, `clmm` liquidity commands, and launchpad trading/claim commands).

## License

MIT
