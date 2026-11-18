# context-left

A Claude Code mod that shows how much of the context window the session uses, in the prompt footer.

The footer label looks like `ctx: 76k/200k (38%)`. Its colour changes as the window fills:

| Used | Colour |
|---|---|
| Below 50% | Green |
| 50% to 80% | Orange |
| Above 80% | Red |

## Contents

- [Agent instructions](#agent-instructions)
- [Requirements](#requirements)
- [Install](#install)
- [How it works](#how-it-works)
- [Automatic compaction](#automatic-compaction)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Licence](#licence)

<a id="agent-instructions"></a>

<details>
<summary><strong>Agent instructions: let a coding agent install the mod</strong></summary>

Paste this prompt into Claude Code or another coding agent. The agent installs the mod and turns on auto-update. It stops before it restarts anything.

```text
Install the Claude Code mod "context-left" from the marketplace at
https://github.com/cmdaltctr/context-left. Do these steps in order:

1. Run `claude --version`. If it is older than 2.1.292, stop and tell me.
2. Run `claude plugin list`. If context-left@inline is listed, or
   ~/.claude/settings.json has the folder in CLAUDE_CODE_PLUGIN_DIRS, stop and tell me.
   A folder copy replaces the marketplace copy.
3. Run:
   claude plugin install context-left --marketplace cmdaltctr/context-left
4. Run `claude plugin list` and show me that context-left@context-left is installed.
5. Turn on auto-update. Claude Code keeps it off for marketplaces that Anthropic does not run.
   a. Copy ~/.claude/settings.json to ~/.claude/settings.json.bak.
   b. In ~/.claude/settings.json, find "extraKnownMarketplaces" -> "context-left".
      The install in step 3 wrote this entry. Add "autoUpdate": true to it, next to "source":
      "context-left": {
        "source": { "source": "github", "repo": "cmdaltctr/context-left" },
        "autoUpdate": true
      }
   c. Change nothing else in the file. Check that the file is valid JSON.
6. Ask me: "Do you want to turn on automatic compaction? It is off by default.
   If it is on, Jev (TypeSafe) clears old tool output before each compaction, and
   the first 1,500 characters of that output go to TypeSafe. It needs a TypeSafe API key."
   Only if I say yes:
   a. Ask me for the key. Do not print it or save it in any file in the repository.
   b. In ~/.claude/settings.json, under "pluginConfigs" -> "context-left@context-left",
      set "compactEnabled" to true under "options". Put the key in "typesafeApiKey".
   c. Change nothing else in the file. Check that the file is valid JSON.
   If I say no, change nothing.
7. Tell me to restart Claude Code.
```

If you turned on compaction, check the settings in `/plugin`. After the restart, run `claude --debug` and look for `hooks module context-left@context-left loaded`. See [Troubleshooting](#troubleshooting) if the line is missing.

</details>

## Requirements

- Claude Code 2.1.292 or later for the one-step install below. Claude Code 2.1.287 and later run mods with no extra setting.
- The footer label needs no API key and no network access.
- Automatic compaction is off by default. Jev (TypeSafe) clearing needs a TypeSafe API key and network access. See [Automatic compaction](#automatic-compaction). Decision record: [ADR-001](docs/adr/001-opt-in-compaction-with-jev-pruning.md).

## Install

This repository is also a plugin marketplace. Install from it, and Claude Code can update the mod for you.

To let a coding agent do these steps, use the [agent instructions](#agent-instructions) at the top of this page.

1. Install the mod from your shell:

   ```sh
   claude plugin install context-left --marketplace cmdaltctr/context-left
   ```

   Inside a Claude Code session, you can use `/plugin install context-left --marketplace cmdaltctr/context-left` instead. Then choose a scope.

2. Turn on auto-update. Auto-update is off by default for marketplaces that Anthropic does not run.
   1. Run `/plugin`.
   2. Open the **Marketplaces** tab.
   3. Select `context-left`.
   4. Select **Enable auto-update**.

   Or add `"autoUpdate": true` to the `context-left` entry under `extraKnownMarketplaces` in `~/.claude/settings.json`. The install writes that entry.
3. Restart Claude Code.

The mod has the id `context-left@context-left`.

### Updates

Claude Code checks for a new version during an interactive session, up to ten minutes after your first message. When it finds one, it shows `Plugin updated: context-left · Run /reload-plugins to apply`. Run `/reload-plugins`, or restart Claude Code.

To update now:

```sh
claude plugin update context-left@context-left
```

Claude Code compares the `version` in `.claude-plugin/plugin.json`. A push with no version change does not reach installed copies.

### Uninstall

```sh
claude plugin uninstall context-left@context-left
claude plugin marketplace remove context-left
```

### Install from a folder (development)

Use this method to change the code. The mod then has the id `context-left@inline`, and it does not update by itself.

1. Clone the repository:

   ```sh
   git clone https://github.com/cmdaltctr/context-left.git ~/.claude/mods/context-left
   ```

2. Add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Separate several folders with `:` on macOS and Linux.

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/context-left"
     }
   }
   ```

3. Restart Claude Code.

A folder copy replaces a marketplace copy with the same name. Do not use both methods on one machine. To try the mod for one session only, run `claude --plugin-dir ~/.claude/mods/context-left`. On Claude Code older than 2.1.287, also set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

## How it works

- At session start, the mod reads the context figures once.
- After each response, Claude Code sends new figures (`session.measure`). The mod stores them. It does not poll.
- The mod draws its label after the other footer labels, with a `·` between them.
- Before the first response, and after a compaction, the label shows `ctx: –` until the next figures arrive.

The colour limits are constants at the top of `hooks/register.tsx` (`ORANGE_FROM = 50`, `RED_ABOVE = 80`).

<a id="automatic-compaction"></a>

## Automatic compaction

This part is off by default. Set `compactEnabled` to `true` to turn it on.

When a turn ends at or above `compactAtPercent` of the window used, the mod starts a compaction. It starts one compaction per crossing. The next one waits until usage falls below the threshold.

The mod changes every compaction while it is on, including `/compact` and the engine's own:

1. Jev (TypeSafe) reads each old tool output and judges whether the model needs it again. Outputs it is sure about are replaced with a short note. Errors, short outputs and the newest three results are never cleared.
2. The summary model (Sonnet at medium effort by default) writes the summary from the cleared conversation.
3. If the Jev step or the summary call fails, the engine compacts as it would without the mod. Each Jev request gets three attempts.

Privacy: with a TypeSafe key set, the first 1,500 characters of each old tool output and your latest request go to TypeSafe. With no key, nothing leaves the machine and step 1 is skipped.

| Setting | Default | What it does |
|---|---|---|
| `compactEnabled` | off | Master switch for this whole section. |
| `compactAtPercent` | 60 | Share of the window used that starts a compaction. Pick 40 to 80. |
| `compactModel` | `sonnet` | Model that writes the summary. Pick `sonnet`, `opus` or `haiku`. |
| `compactEffort` | `medium` | Reasoning effort of the summary call. |
| `typesafeApiKey` | empty | TypeSafe key. Empty skips the Jev step. |
| `typesafeModel` | `jev-latest` | Jev model. |
| `keepRecentToolResults` | 3 | Newest tool results Jev is never asked about. Pick 1 to 8. |
| `dropConfidence` | 0.8 | How sure Jev must be before an output is cleared. Higher clears less. Pick 0.6 to 0.95. |
| `jevTimeoutMs` | 5000 | Wait per Jev attempt. Pick 3000 to 20000. |
| `resetToDefaults` | off | On: every value above except the key and `compactEnabled` is ignored and the defaults apply. |

The config menu shows a default only for a toggle or a picker, so the numbers are pickers. A stored value outside a picker's list counts as unset.

Set them with `/plugin`, or under `pluginConfigs` in `~/.claude/settings.json`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No `ctx:` label in the footer | Run `claude --debug`. Look for `hooks module context-left@context-left loaded`. If the line is missing, run `claude plugin list` and check that the mod is installed and turned on. |
| Two `ctx:` labels | A folder copy and a marketplace copy are both loaded. Remove one. |
| Label stays `ctx: –` | Send one message. The figures arrive after the first response. |

## Development

| File | Purpose |
|---|---|
| `hooks/register.tsx` | The hooks module. Stores the figures, draws the footer label and starts compactions. |
| `hooks/compact.ts` | Compaction logic: Jev judgments, clearing and the summary. |
| `hooks/register.test.ts` | Tests for the colours, the update after each response, the footer layout and the trigger. |
| `hooks/compact.test.ts` | Tests for the Jev calls, the clearing and the compaction hook. |
| `.claude-plugin/plugin.json` | Manifest. |
| `.claude-plugin/marketplace.json` | Marketplace entry for this repository. |
| `types/index.d.ts` | Type declaration for the stored state. |

```sh
claude plugin test .
claude plugin validate .
```

To release a change to marketplace users, raise `version` in `.claude-plugin/plugin.json`, then push to `main`. Installed copies ignore a push with no version change.

Mods are early access. The `$` API can change between Claude Code releases.

## Licence

Released under the MIT licence. See [LICENSE](LICENSE).
