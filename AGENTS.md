# AGENTS.md for context-left

Rules for agents that change this mod. For install steps, read `README.md`.

## Layout

- `hooks/register.tsx` is the only hooks module. `hooks/hooks.json` names it.
- `hooks/register.test.ts` holds the tests.
- `.claude-plugin/plugin.json` is the manifest. `.claude-plugin/marketplace.json` makes this repository its own marketplace.
- `.claude-plugin/types/` is generated and ignored by git. Do not edit it.

## Rules

1. Keep the mod free of `node_modules`, network calls and polling. The figures come from `session.start` and `session.measure`.
2. Always call `next(e)` in each hook and return its result. Other mods draw in the same footer.
3. Keep the colour limits as the constants `ORANGE_FROM` and `RED_ABOVE` at the top of `register.tsx`.
4. Write a failing test before you fix a bug. Check that the test fails on the old code.
5. Use British English in comments, docs and commit messages. Use Conventional Commits.

## Checks

Run both commands before you commit. Both must pass.

```sh
claude plugin test .
claude plugin validate .
```

The validator warns `ICON_MISSING`. That warning is known and does not block an install.

## Release

1. Raise `version` in `.claude-plugin/plugin.json` for each code change. Installed copies ignore a push with no version change.
2. A change to docs only needs no version change.
3. Push to `main`.

## Privacy

Before you push, search the tracked files for personal names, home folder paths and email addresses:

```sh
git ls-files -z | xargs -0 grep -In -E "/Users/|/home/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}"
```

Fix every hit.
