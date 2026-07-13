# Interactive CLI UX

Interactive prompts are a human-facing layer over the same command actions used by flags. They must not change JSON output or non-interactive automation behavior.

Every command input that is required for an action can now be omitted in a
terminal and collected by a prompt. Explicit flags remain available for
scripts; JSON output and non-TTY execution never prompt and instead return a
`MISSING_OPTIONS` error with automation guidance.

## Wizard candidates

| Command pattern | Wizard flow | Smart defaults |
| --- | --- | --- |
| `swap` | Choose wallet token, choose destination token, enter amount, review quote, confirm | Configured slippage and priority fee |
| `clmm open-position` | Search pool, choose token, enter amount, choose range preset or custom range, review | Configured slippage; current price as range context |
| `clmm increase-liquidity` | Select a position, choose deposit token, enter amount, review ratio | Active wallet; configured slippage |
| `clmm decrease-liquidity` | Select a position, choose percentage, optionally swap proceeds, review | 25/50/75/100 percent choices |
| `clmm collect-fees` / `close-position` | Select eligible positions, review totals, confirm | Hide positions with no collectible balance |
| `clmm create-pool` | Enter token mints, fee tier, initial price, review, confirm | Configured priority fee |
| `cpmm swap` / `liquidity` | Enter pool, token, and amount inputs, review quote, confirm when executing | Configured slippage and priority fee |
| `launchpad create` | Choose platform/config, enter token metadata, review upload and transaction | Active cluster and wallet |
| `wallet use` | Select from wallet names rather than requiring a name | Current active wallet highlighted |

`config init` and wallet secret flows are already interactive. Read-only inspection and export commands should remain direct because prompts make shell composition harder.

## Smart Swap prototype

Running `raydium swap` with missing flags in a TTY launches the prototype. Token choices include SOL, mainnet USDC, and nonzero wallet token balances. Users can always enter an arbitrary mint. The configured slippage is shown and reused without adding an unnecessary prompt.

Supplying all flags bypasses the wizard. `--json` and non-TTY invocations never prompt; missing values produce a structured `MISSING_OPTIONS` error.

Future token search should add verified symbol/name metadata from a configurable provider. Mint address must remain visible in the selection and quote review because symbols are not unique.

The guided swap now uses a stateful wizard with Back and Cancel navigation. Its final step makes the safe choice explicit: review a quote only, or continue to simulation and execution. Wallet secrets remain locked until after the transaction review is accepted.

Normal `swap --help` shows only the common input and execution options. `swap --help-all` reveals direct-pool routing, quote approval, fee overrides, and safety acknowledgements. These options remain stable for automation even though they are hidden from the primary human workflow.

## Transaction review

Human-facing swap quotes and executions use a shared review panel with aligned values, full token mints, network context, simulation status, and focused risk warnings. Output adapts to terminal width and remains plain structured JSON in automation mode.

Confirmations have risk levels. Ordinary writes can use `--yes`; dangerous actions use a typed confirmation unless the caller supplies the relevant explicit safety acknowledgement or a matching fresh quote ID. Secret actions must opt into any non-interactive bypass separately.

## Error disclosure

Human output has three levels:

1. A concise statement of what failed.
2. One or two concrete next steps.
3. Raw SDK/RPC details only with `--debug`.

JSON errors retain stable `error`, `code`, `details`, and `hints` fields. Initial shared codes cover missing input, invalid addresses and amounts, wallet state, RPC authentication/rate limits, insufficient balances, slippage, network failures, expired transactions, and existing output files.

New commands should use `logGuidedError` for validation failures and `explainError` when wrapping SDK, RPC, or filesystem errors.
