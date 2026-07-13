---
name: raydium-diagnostics
description: Inspect confirmed Solana transaction status, logs, costs, and explorer URLs with the Raydium CLI.
---

# Raydium Diagnostics

Use this skill to investigate a transaction without a wallet.

```bash
raydium --json tx inspect <signature>
```

The output reports confirmation availability, on-chain error, fee, compute units, logs, and the configured explorer URL.

## Agent Rules

1. Treat a missing transaction as an RPC visibility issue until its status and explorer URL are checked.
2. Return the logs and on-chain error unchanged; do not claim a recovered outcome from an unsuccessful transaction.
3. This command is read-only and never opens a browser in JSON mode.
