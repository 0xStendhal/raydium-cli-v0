---
name: raydium-farm
description: Inspect Raydium farm rewards, APR, TVL, and schedules with the Raydium CLI.
---

# Raydium Farm

Use this skill for read-only farm diagnostics. Farm staking, unstaking, reward funding, and harvesting are not exposed yet.

## Inspect a Farm

```bash
raydium --json farm show <farm-id>
```

The response includes the LP mint, reward mints and rates, schedules when supplied by the API, APR, TVL, and tags. It does not require a wallet or password.

## Agent Rules

1. Validate that the caller supplied a farm address.
2. Use `--json` for automation.
3. Report API data as current market information, not as a guaranteed future reward rate.
4. Do not propose reward funding or other farm-admin actions.
