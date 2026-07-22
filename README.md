# Raydium CLI

CLI tool for interacting with Raydium on Solana -- swap, manage CLMM/CPMM positions, launch tokens, and more.

## Install

```bash
npm install -g https://github.com/0xStendhal/raydium-cli-v0/archive/refs/heads/main.tar.gz
```

Or install from a local checkout:

```bash
git clone https://github.com/0xStendhal/raydium-cli-v0.git
cd raydium-cli-v0
npm install
npm run build
npm link
```

## Install Skills (Codex or Claude)

Copy the Raydium skills into your agent's local skills directory.

For Codex:

```bash
mkdir -p ~/.codex/skills
git clone https://github.com/0xStendhal/raydium-cli-v0.git /tmp/raydium-cli-v0
cp -R /tmp/raydium-cli-v0/skills/* ~/.codex/skills/
```

For Claude Code:

```bash
mkdir -p ~/.claude/skills
git clone https://github.com/0xStendhal/raydium-cli-v0.git /tmp/raydium-cli-v0
cp -R /tmp/raydium-cli-v0/skills/* ~/.claude/skills/
```

## Quick Start

```bash
raydium config init          # interactive setup (cluster, RPC URL, slippage, explorer, priority fee)
raydium wallet create main   # create an encrypted wallet
raydium --help               # see all commands
```

All commands support `--json` for machine-readable JSON output. Prefer `--password-stdin` for wallet commands. `--yes` bypasses the final send confirmation, so use it only after a separate quote and policy check.

## Configuration

Config is stored at `~/.raydium-cli/config.json`.

```bash
raydium config init                           # interactive setup wizard
raydium config set cluster devnet             # switch SDK + API usage to devnet
raydium config set rpc-url <url>              # set RPC endpoint
raydium config set default-slippage 0.5       # set default slippage (%)
raydium config set priority-fee 0.000005      # set default priority fee (SOL)
raydium config set explorer solscan           # solscan | solanaFm | solanaExplorer
raydium config set pinata-jwt <jwt>           # set Pinata JWT for IPFS uploads
raydium config get                            # show all config with secrets redacted
raydium config get rpc-url                    # show single value
```

## Wallets

Wallets are stored at `~/.raydium-cli/wallets/` and encrypted with AES-256-GCM (PBKDF2 key derivation).
Mnemonic-based wallets default to the standard Solana derivation path `m/44'/501'/0'/0'`, and the selected derivation path is stored in wallet metadata.

```bash
raydium wallet create [name]                          # writes seed phrase to a 0600 file by default
raydium wallet create [name] --derivation-path "m/44'/501'/0'/0'"
raydium wallet create [name] --seed-phrase-file /secure/path/seed.txt
raydium wallet import <name>                          # import from private key or seed phrase (interactive)
raydium wallet import <name> --private-key-stdin
raydium wallet import <name> --seed-phrase-file /secure/path/seed.txt
raydium wallet import <name> --derivation-path "m/44'/501'/0'/0'"
raydium wallet list                                   # list all wallets
raydium wallet use <name>                             # set active wallet
raydium wallet balance [name]                         # SOL + token balances with USD values and a portfolio total
raydium wallet balance --all                           # include dust (< $0.01) and zero-value tokens
raydium wallet export <name>                          # writes private key to a 0600 file by default
raydium wallet export <name> --file /secure/path/private-key.txt
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

First obtain and validate a quote. JSON execution requires the returned `quoteId`, so agents cannot accidentally turn an unreviewed quote into a send:

```bash
QUOTE_ID="$(raydium --json swap \
  --input-mint <mint> \
  --output-mint <mint> \
  --amount <number> | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).quoteId')"

printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --password-stdin swap --execute \
  --input-mint <mint> \
  --output-mint <mint> \
  --amount <number> \
  --approve-quote "$QUOTE_ID"
```

## Swap

Supports auto-routed Trade API quotes and safe execution, plus direct standard-AMM pool quotes.

```bash
# Interactive token selection from SOL, USDC, and wallet balances
raydium swap

# Auto-routed quote (default -- does not sign or send)
raydium swap --input-mint <mint> --output-mint <mint> --amount 1

# Exact-output quote (find the maximum input needed for the requested output)
raydium swap --exact-out --input-mint <mint> --output-mint <mint> --amount 1

# Execute an auto-routed swap interactively: builds, simulates, displays a transaction review, then confirms
raydium swap --execute --input-mint <mint> --output-mint <mint> --amount 1

# Direct standard-AMM pool quote
raydium swap --pool-id <pool> --input-mint <mint> --amount 1

# Execute an exact-input direct standard-AMM pool swap interactively
raydium swap --execute --pool-id <pool> --input-mint <mint> --amount 1

# With options
raydium swap --execute --input-mint <mint> --output-mint <mint> --amount 1 \
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

The CPMM commands are oriented around pool inspection, direct guarded swaps, and proportional liquidity. Quotes never require a wallet or send a transaction. Pool creation is not exposed yet.

### Inspect and Quote

```bash
raydium cpmm configs                                  # list available fee tier configurations
raydium cpmm configs --devnet                         # devnet configs
raydium cpmm pool <pool-id>                            # RPC state; indexed API fallback for unsupported layouts

# direct CPMM quote (default)
raydium cpmm swap --pool-id <pool> --input-mint <mint> --amount 1

# exact-output CPMM quote
raydium cpmm swap --pool-id <pool> --exact-out --output-mint <mint> --amount 1

# execute a CPMM swap only after a refreshed quote and local simulation
raydium cpmm swap --execute --pool-id <pool> --input-mint <mint> --amount 1
```

CPMM swaps use the same 5% slippage and 0.01 SOL priority-fee acknowledgement caps as routed swaps. The CLI has a hard 0.1 SOL maximum priority fee per transaction. Quotes show the enforced minimum output or maximum input; price can still move before a transaction lands.

`cpmm pool` prefers decoded RPC state. When the pinned SDK cannot decode a newer CPMM account layout, it falls back to Raydium's indexed API and labels the result `source: raydium-api`; those values may be stale and cannot be used to quote or execute a transaction. Update and validate the SDK before acting on such a pool.

### Add and Remove Liquidity

```bash
# Quote a proportional deposit from one side (default)
raydium cpmm liquidity add --pool-id <pool> --input-mint <mint> --amount 10

# Execute after a refreshed quote, simulation, and review
raydium cpmm liquidity add --execute --pool-id <pool> --input-mint <mint> --amount 10

# Quote a withdrawal by LP-token amount
raydium cpmm liquidity remove --pool-id <pool> --lp-amount 1.5

# Keep wrapped SOL after withdrawal instead of unwrapping it
raydium cpmm liquidity remove --execute --pool-id <pool> --lp-amount 1.5 --keep-wsol
```

Deposit quotes show the other token currently required and the minimum LP tokens minted. Withdrawal quotes show minimum receipts after slippage and any supported Token-2022 transfer fee. Amounts are refreshed immediately before execution; a changed pool state can still cause the transaction to fail rather than spend above its displayed limits.

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
| `--password <value>` | Wallet password (unsafe; requires `--unsafe-secret-flags`) |
| `--password-stdin` | Read wallet password from stdin |
| `--unsafe-secret-flags` | Allow passing secrets directly on the command line |
| `--keystore <name-or-path>` | Wallet name or path to wallet file |

## Diagnostics

```bash
# Read a transaction's confirmed status, logs, fees, compute usage, and explorer URL
raydium tx inspect <signature>
raydium --json tx inspect <signature>

# Read farm rewards, APR, TVL, and schedules without a wallet
raydium farm show <farm-id>
```

## Swap Safety

`raydium swap` is quote-only by default, so quoting never decrypts a wallet or sends a transaction. Add `--execute` to build and locally simulate an auto-routed transaction before the final confirmation. `--exact-out` treats `--amount` as the requested output amount.

JSON execution requires `--approve-quote <quoteId>` from a fresh quote response. Interactive execution prints the same quote ID but still uses the final Y/N prompt.

The CLI rejects slippage above 5% and priority fees above 0.01 SOL unless you explicitly add `--allow-high-slippage` or `--allow-high-priority-fee`; priority fees above 0.1 SOL are always rejected. Each execution resolves V0 lookup tables, requires the active wallet to be the sole signer and fee payer, checks the serialized transaction against its allowed top-level programs, checks its compute budget, and reports the maximum priority fee. Multi-transaction Trade API responses fail closed because they cannot be simulated atomically.

After confirmation, JSON receipts include `explorerUrl`. Interactive commands print the configured explorer URL and ask whether to open it; decline is the default.

Command-specific flags such as `--priority-fee` and `--slippage` are available only on commands that define them (for example `swap`, `clmm` liquidity commands, and launchpad trading/claim commands).

Human-facing failures show a short explanation and suggested next steps. Add `--debug` for raw SDK or RPC details; JSON errors include a stable error code and hints. See [Interactive CLI UX](docs/interactive-ux.md) for the wizard and error-handling conventions.

## License

MIT
