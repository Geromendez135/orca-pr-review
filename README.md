# PR Review (Orca plugin)

Review the changes of the focused workspace's branch against its PR base, inside Orca.

## Install

```sh
orca plugin install Geromendez135/orca-pr-review
```

It is also listed in Orca's community plugins (Settings → Plugins). It runs its own code (a Node worker that calls
`git`, `gh` and the `orca` CLI), so Orca asks you to approve its access on install. Then open **PR Review**
from the right sidebar.

Needs Orca 1.4.248 or later, `git`, and optionally the GitHub CLI (`gh`) to find the PR's base branch.

## Features

- **File tree** of every changed file, with status, +/− counts and a viewed checkbox.
- **Viewed files** collapse. A file that changes after you viewed it is unchecked again and shows a dot.
- **Viewed changes**: hover a change and press **✓ Viewed**. Its diff disappears and the block shows as the
  final code with a green bar. **↺ Show diff** brings it back. Viewing every change marks the file viewed.
- **Comments for the agent**: click or drag line numbers (shift-click extends), write a comment, and
  **Add comment**. Comments queue in the bottom tray. **Send to agent** delivers them all, with file,
  line range and the selected code, to a chat agent (`orca orchestration send`), a terminal agent
  (`orca terminal send`), or a new Claude chat. **Send now** sends one comment straight away.
- **Full file** on a file's header shows the whole file from top to bottom with the changes in place;
  **Changes only** goes back. Viewed changes and comments carry across both views.
- **Minimap** on the right of the diffs, like VS Code's: every file in order, labelled, with removed and
  added lines in red and green, comments in yellow and viewed changes marked green. Click to jump, drag the
  slider to scroll. The **Minimap** button hides it; it also hides in narrow panes.
- **Find** (⌘F or the Find button) searches the code of every file in the review, collapsed and viewed
  files included. ↩ / ⇧↩ or ⌘G / ⇧⌘G move between matches, **Aa** matches case, Esc closes.
- **With local / Committed** switches between "commits plus uncommitted work" and "only commits".
- **Open in tab** opens the same review in a wide editor tab (`.pr-review/Review.prreview`).

The base is the PR's base branch (`gh pr view`), then `origin/HEAD`, then `origin/main`. Override it under
Settings → Plugins → PR Review. The diff is against the merge base, like GitHub. The plugin does not fetch:
run `git fetch` if the base is stale.

Viewed state and draft comments live in the plugin's storage, per workspace path. Sent comments are also
written to `.pr-review/sent-*.md` in the workspace; the plugin adds `/.pr-review/` to `.git/info/exclude`.

## Develop

The worker is `src/worker.ts` (diff parsing in `src/diff.ts`); the UI is `ui/app.js` and `ui/minimap.js`,
shared by the sidebar panel and the editor tab. highlight.js is vendored in `vendor/` (BSD-3-Clause).

```sh
orca plugin types .            # writes .orca/types for tsc
orca plugin dev watch . --check --json
orca plugin test . --json
npm install && npx tsc -p .
```
