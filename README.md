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
6. Tell me to restart Claude Code.
```

After the restart, run `claude --debug` and look for `hooks module context-left@context-left loaded`. See [Troubleshooting](#troubleshooting) if the line is missing.

</details>

## Requirements

- Claude Code 2.1.292 or later for the one-step install below. Claude Code 2.1.287 and later run mods with no extra setting.
- No API key and no network access.

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

The colour limits are constants at the top of `hooks/register.tsx` (`ORANGE_FROM = 50`, `RED_ABOVE = 80`). The mod has no options.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No `ctx:` label in the footer | Run `claude --debug`. Look for `hooks module context-left@context-left loaded`. If the line is missing, run `claude plugin list` and check that the mod is installed and turned on. |
| Two `ctx:` labels | A folder copy and a marketplace copy are both loaded. Remove one. |
| Label stays `ctx: –` | Send one message. The figures arrive after the first response. |

## Development

| File | Purpose |
|---|---|
| `hooks/register.tsx` | The hooks module. Stores the figures and draws the footer label. |
| `hooks/register.test.ts` | Tests for the colours, the update after each response and the footer layout. |
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
