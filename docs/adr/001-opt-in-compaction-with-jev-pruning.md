# ADR-001: Opt-in compaction with Jev pruning

- **Date:** 2026-11-18
- **Status:** Proposed
- **Deciders:** Repository owner

## Context

Claude Code compacts the conversation when the context window is nearly full. A summary written from a crowded window is worse than one written earlier. Most of the crowding is old tool output, such as file reads and search results, which the model rarely needs again.

Research (Anthropic docs and practitioner reports) points to three practices:

1. Compact earlier than the engine does, around 50 to 60% used, and at a turn boundary.
2. Clear old tool output before summarising.
3. Pin the goal, constraints, decisions, errors and file paths in the summary.

`context-left` already receives the context figures after each turn. Adding compaction there avoids a second mod. The mod must stay safe for people who only want the footer label.

## Decision

Extend `context-left` with optional automatic compaction, off by default (`compactEnabled`).

- **Trigger:** a main-loop turn that ends at or above `compactAtPercent` (default 60) calls `$.session.compact`. It fires once per crossing and re-arms when usage falls below the threshold.
- **Pruning:** a `session.compact` hook sends old tool outputs to Jev (TypeSafe) as yes/no questions: does the model still need this output? Outputs Jev is at least `dropConfidence` (default 0.8) sure about are replaced with a short note. Errors, short outputs and the newest three results are never sent. Each request has three attempts.
- **Summary:** the same hook asks a chosen model (default Sonnet at medium effort) to write the summary from the cleared conversation. The API of `$.session.compact` takes no model or effort, so the hook writes the summary itself.
- **Failure rule:** if Jev or the summary call fails, the engine compacts as it would have, with the cleared messages and a pin instruction. Pruning never blocks a compaction.
- **Settings:** every value is a toggle or picker in the `/plugin` menu, because the menu shows defaults only for those. `resetToDefaults` ignores the stored values.
- **Network rule:** the only network call goes to TypeSafe, only when compaction is on and a key is set. This amends the earlier "no network calls" rule in `AGENTS.md`.

## Consequences

### Positive

- Smaller, cleaner summaries, made earlier in the session.
- Off by default, so existing users see no change.
- Model and effort of the summary are under the user's control.
- Failures fall back to the engine's own compaction.

### Negative

- With a key set, excerpts of tool output (first 1,500 characters each) and the latest request go to TypeSafe.
- The mod now owns a summary prompt, which needs upkeep.
- A wrongly cleared output is lost to the model. The 0.8 default and the exclusions limit this, and the model can run the tool again.

### Neutral

- `compactEnabled` changes every compaction while on, including `/compact` and the engine's own.
- Numbers are text pickers, read back as numbers.

## Alternatives Considered

| Option | Rejected Because |
|--------|-----------------|
| Set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` only | Moves the trigger but cannot prune tool output or choose the summary model. A GitHub issue reports it not always firing. |
| A separate compaction mod | More code to maintain. The percentage figures already live in `context-left`. |
| Rules only, Jev later | Chosen against: Jev was wanted from the first version. |
| Always on | Sends tool output to a third party and changes compaction for everyone. |
| Number fields in the settings menu | The menu shows no default for them. |

## References

- [`hooks/compact.ts`](../../hooks/compact.ts), [`hooks/register.tsx`](../../hooks/register.tsx)
- [Anthropic: effective context engineering for AI agents](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
- [Anthropic: context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [TypeSafe API](https://docs.typesafe.ai/api.md)
- The same Jev call pattern as the `model-effort-router` mod

## Verification status

Unit tests and `claude plugin validate` pass. A live check in a Claude Code session is pending: whether the engine accepts the hook's summary, and whether `$.session.compact` works from `turn.complete`. Set the status to Accepted after that check.
