---
name: agent-setup-and-wallet
description: Perform one-time Raydium CLI setup for agents and handle wallet basics. Use this skill to install Raydium CLI, configure RPC/default options, create or import a wallet, and fetch complete wallet balances.
---

# Raydium Agent Setup And Wallet (One-Time + Wallet Basics)

Use this skill before any workflow that requires signing transactions.

## Install

```bash
npm install -g github:0xStendhal/raydium-cli-v0
```

## Configure RPC & Defaults

```bash
raydium config set rpc-url <your-rpc-url>
raydium config set default-slippage 0.5
raydium config set priority-fee 0.000005
raydium config set pinata-jwt <your-pinata-jwt>   # required for launchpad create --image uploads
```

## Create or Import a Wallet

```bash
# Create a new wallet
raydium --json --password "yourpassword" wallet create my-wallet

# Or import an existing one
raydium --json --password "yourpassword" wallet import my-wallet  # (Note: Interactive prompts are disabled with --json, use stdin or automation methods for secrets)

# Set it as active
raydium wallet use my-wallet

# Check balance
raydium --json --keystore my-wallet --password "yourpassword" wallet balance
```

## Running Commands Non-Interactively

For agent execution, use non-interactive flags and the active wallet from CLI config (`raydium wallet use <name>`):

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --password-stdin <command>
```

- `--json` - machine-readable JSON output
- `--yes` - auto-confirm prompts
- wallet is resolved from active wallet config unless `--keystore` is explicitly provided
- use `RAYDIUM_WALLET_PASSWORD` from environment for non-interactive signing

## Environment Loading Rule (Agent UX)

Before running signing commands, ensure `.env` is loaded in the same shell/session:

```bash
set -a; source .env; set +a
```

If commands run in isolated shells, prefix each signing command with env loading:

```bash
set -a; source .env; set +a; printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --yes --password-stdin <command>
```

## Execution Discipline Rule

When a workflow skill provides an exact command, execute that command directly.

1. Do not probe with `--help` first.
2. Do not retry alternate variants unless the canonical command fails.
3. For any command requiring wallet decryption or signing, include password auth on the first attempt (`--password-stdin` or `--password`).

## Wallet Balance Output Rule

When the user asks for wallet balances, run JSON mode and include all token balances.

```bash
printf '%s' "$RAYDIUM_WALLET_PASSWORD" | raydium --json --password-stdin wallet balance
```

Agent output requirements:
- Always include SOL.
- Include every token entry returned by the CLI (`mint`, `amount`, `raw`, `decimals`).
- If the list is long, provide a short summary plus the full token list (do not drop entries).
