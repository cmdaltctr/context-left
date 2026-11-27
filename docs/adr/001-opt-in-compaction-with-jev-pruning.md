# ADR-001: Opt-in compaction with Jev pruning

- **Date:** 2026-11-18
- **Status:** Accepted (amended 2026-11-27)
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

- **Trigger:** a main-loop turn that ends at or above `compactAtPercent` (default 60) calls `$.session.compact` at once, from `turn.complete`. It fires once per crossing and re-arms when usage falls below the threshold or when the engine refuses the call.
- **Pruning:** a `session.compact` hook sends old tool outputs to Jev (TypeSafe) as yes/no questions: does the model still need this output for the person's newest message? Background events, slash-command records and `!` shell rows are not counted as that message. Outputs Jev is at least `dropConfidence` (default 0.8) sure about are replaced with a short note. Errors, short outputs and the newest three results are never sent. Each request has three attempts.
- **Summary:** the engine writes the summary from the cleared conversation. The hook adds a pin instruction: keep the goal, constraints, decisions, open errors and file paths. The hook does not write its own summary (see Amendment).
- **Failure rule:** if Jev fails, the engine compacts as it would have, with the pin instruction. Pruning never blocks a compaction.
- **Log:** each compaction logs `Jev cleared X of Y old tool outputs`, so the user can see that Jev works.
- **Settings:** every value is a toggle or picker in the `/plugin` menu, because the menu shows defaults only for those. `resetToDefaults` ignores the stored values.
- **Network rule:** the only network call goes to TypeSafe, only when compaction is on and a key is set. This amends the earlier "no network calls" rule in `AGENTS.md`.

## Consequences

### Positive

- Smaller, cleaner summaries, made earlier in the session.
- Off by default, so existing users see no change.
- Failures fall back to the engine's own compaction.

### Negative

- With a key set, excerpts of tool output (first 1,500 characters each) and the latest request go to TypeSafe.
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

## Amendment (2026-11-27): the engine writes the summary

Version 0.2.1 let the hook write the summary with a chosen model. A review of the 10 compactions from 18 to 27 November found:

1. The hook's summary was never used in a real session. The hook skipped it without a log line when the transcript passed 500,000 characters. Text that other hooks inject into each turn pushed every large session past that limit.
2. The engine wrote all 10 summaries. They kept the user's words, decisions with reasons and file paths. No user message after them showed lost context.
3. A summary written by the hook is weaker. It drops the newest messages that the engine keeps word for word, cuts each tool output to 1,200 characters, and has no link to the full transcript.

Decision: remove the hook's summary and the `compactModel` and `compactEffort` settings. Keep the trigger, the Jev clearing and the pin instruction, and add the log line.

The same review found two more defects, fixed in version 0.3.0:

1. **Start delay.** The trigger waited 1 second after the turn before it called `$.session.compact`. A background event (a Monitor event, for example) starts a new turn within that second, and the engine refuses a compaction during a turn. In a test with a Monitor event every 2 seconds, the 1-second wait failed 7 of 7 times. A call at once from `turn.complete` started 7 of 8 times, and the one refusal re-armed for the next turn. The trigger now calls at once.
2. **Wrong request for Jev.** Jev weighed old outputs against the newest user-role row. The engine also stores background events and command records in that role, so in a session with background tasks Jev judged against text such as "Monitor event: tick". Jev now uses the newest message the person typed.

## Verification status

Unit tests (38) and `claude plugin validate` pass. Live checks in headless sessions on 2026-11-27:

- Version 0.2.1: the engine accepted the hook's summary ("core never ran").
- Version 0.3.0: the hook logged `Jev cleared 1 of 2 old tool outputs`, and the engine wrote the summary.
- Version 0.3.0, interactive session with a Monitor event every 2 seconds: the compaction started as the turn ended, Jev answered in 224 ms, and the engine wrote the summary (183k to 42k tokens). The queued Monitor events arrived after it, none lost.
- Version 0.3.0, after Monitor events and a slash command: the request given to Jev was the person's message.
