# scratch-auto-approve

A user-level DeepSeek Harness plugin that:

1. **Auto-approves every approval request** — installs a one-line answerer on
   the `approval/request` waterfall that always returns `'allowed-once'`.
2. **Blocks file-deletion operations that target paths outside the workspace**
   — installs a `tools/pre-execute` gate that regex-scans bash-style commands
   for deletion keywords and rejects any whose target paths fall outside the
   configured workspace root.

The two policies are independent. You can disable the workspace check
(`enforceWorkspaceBoundary: false`) and keep the auto-approval; you can
also disable auto-approval (by removing this plugin) and keep the deletion
gate by registering a different approval answerer upstream.

> Status: MVP. The plugin is a self-contained directory registered as a
> pnpm workspace member; pnpm symlinks the harness packages it needs
> into `scratch-auto-approve/node_modules/` so a plain-node (`:lib`)
> load from `cordis.yml` resolves them at runtime.

## Layout

```
scratch-auto-approve/
├── README.md
├── package.json
├── tsconfig.json
├── cordis.yml
└── src/
    ├── index.ts        # apply() — registers the two listeners
    ├── config.ts       # Config schema + resolveConfig
    └── policy.ts       # deletion detection + path extraction + verdict
```

## Setup (one-time)

After editing `pnpm-workspace.yaml` to include this directory, run from
the repo root:

```sh
pnpm install
```

pnpm will symlink `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, and
`@deepseek-ai/dsh-user-approval` into
`scratch-auto-approve/node_modules/`.

## Run

Combine with the existing patch you already use:

```sh
pnpm dsh web \
  --patch ./scratch-wechat-article/cordis.yml \
  --patch ./scratch-auto-approve/cordis.yml
```

The terminal logs a one-line `[auto-approve] loaded: …` summary at boot
that includes the active workspace root and whether the boundary check
is on.

## Configure

Edit `cordis.yml` under the `config:` key:

| Field | Default | Notes |
|---|---|---|
| `workspace` | `process.cwd()` | Absolute path. Deletion targets must resolve inside this directory. |
| `enforceWorkspaceBoundary` | `true` | When `false`, the plugin only auto-approves and skips all path checks. |
| `allowOutsideWorkspace` | `[]` | Exact-match list of full command strings (trimmed) that bypass the boundary check. Use sparingly — typically for `git clean -fd` inside a sub-repo. |

## How it works

### Auto-approval

Harness routes permission questions through the `approval/request`
waterfall (`packages/interaction/user-approval/src/index.ts:30`). Any
listener that returns an `ApprovalOutcome` claims the request; calling
`next()` delegates. This plugin registers a listener that always returns
`'allowed-once'` without calling `next()`, so it short-circuits all
subsequent answerers (UI dialogs, ACP machine channel, etc.).

A consequence: any tool that previously prompted you will now run
silently. There is no per-tool allow / deny list in this MVP — the
deletion gate below is the only remaining safety net.

### Deletion boundary

Harness dispatches tools through the `tools/pre-execute` waterfall
(`packages/core/tools/src/index.ts:152`). Returning
`{ kind: 'deny', reason }` aborts the call before the tool body runs.
Returning `next()` delegates to the next gate (which in default
configurations is the approval seam — which we just auto-approved).

This plugin's `tools/pre-execute` listener:

1. Skips non-bash tools (`bash`, `subprocess`, anything ending in
   `:bash`). Structured file tools (e.g. `dsh-tool-fs`) handle their
   own policy through the `ctx.fs` provider.
2. Reads `args.command` and runs a regex sweep for deletion keywords
   across POSIX (`rm`, `rmdir`, `unlink`), cmd.exe (`del`, `rd`),
   PowerShell (`Remove-Item`, `Clear-Content`, `Move-Item`), and
   common composite commands (`git clean`, `git rm`, `fsutil`).
3. Extracts candidate paths from quoted strings and from bare tokens
   that look like paths (POSIX absolute, `~/`, `./`, `../`,
   `C:\`-style drive letters, `\\`-style UNC).
4. For each candidate, calls `isInsideWorkspace(target, workspace)` —
   which uses Node's `path.relative` after `path.resolve` on both
   sides. Paths with `..` in the relative result, or with a different
   drive letter, count as outside.
5. Verdicts:
   - No deletion keyword in the command → **allow**.
   - Hits the exact-match allowlist → **allow** (audit-logged).
   - Deletion keyword + zero extractable paths → **deny**
     (conservative default: an ambiguous deletion command is a
     dangerous command).
   - All extracted paths inside the workspace → **allow**
     (audit-logged).
   - Any extracted path outside the workspace → **deny** with a
     reason listing the workspace root, the offending paths, and the
     original command (truncated to 200 chars).

### Audit trail

The plugin logs at:

- `WARN` level on boot (workspace path, boundary on/off).
- `WARN` level on every denial (with the full reason).
- `INFO`/`DEBUG` level on every auto-approval (depending on log
  verbosity).

To watch denials in real time while developing, set the harness log
level in the appropriate config or use `LOG_LEVEL=debug`.

## Extending

- **Per-tool policies** — add a tool-name switch at the top of the
  `tools/pre-execute` listener. For example, treat `bash` more
  strictly than `subprocess` (or vice versa).
- **Per-user allowlist** — promote `allowOutsideWorkspace` to a
  settings namespace via `ctx.settings.register(...)` if you want to
  edit it at runtime instead of editing `cordis.yml`.
- **Heavier deletion detection** — extend `extractCandidatePaths` to
  follow shell variables (`$FOO`, `${BAR}`) by resolving them against
  the agent's environment. Out of scope for the MVP because it
  requires reading the child process's env, which is not exposed
  through the `tools/pre-execute` arguments.
- **Sub-agent containment** — today the boundary check is per command.
  A prompt-injected sub-agent could still `git clone` something
  destructive. If that becomes a concern, add a `ctx.subagents.before`
  listener that checks each child's declared scope against the
  workspace.

## Known limitations

- **Path detection is heuristic** — `extractCandidatePaths` cannot
  resolve shell variables or follow redirections. A command like
  `rm "$WORK/foo"` will extract the literal `$WORK/foo`, fail the
  isInsideWorkspace check (or pass it if `$WORK` happens to lex as
  a path), and the model can craft a command that evades detection
  by stashing the path in an env var.
- **No structured-file-tool coverage** — the gate does not inspect
  `dsh-tool-fs` calls because the dsh-tool-fs package already
  mediates its writes through `ctx.fs` and the observation policy.
  If you mount a different file tool that doesn't go through `ctx.fs`,
  add it to `isBashLike` or write a separate check.
- **No undo for in-workspace deletes** — the plugin only blocks
  *outside* deletes. A model with full auto-approval can still `rm -rf`
  something inside the workspace. If you want a confirmation prompt
  even for in-workspace deletes, set `enforceWorkspaceBoundary: false`
  and add a per-tool gate that requires the call to match the
  `allowOutsideWorkspace` allowlist, or just remove this plugin
  entirely and use the default ask policy.

## Troubleshooting

- **No `[auto-approve] loaded:` line at boot** — the patch is not
  applied. Check the `--patch` argument; the YAML path must be
  exactly the one you pass.
- **Plugin loaded but approvals still prompt** — another answerer
  is registered with `prepend: true` and is running ahead of this
  one. The dsh-user-approval package documents that sibling listener
  order is not a priority mechanism; if you need a hard override,
  put this plugin last in the `--patch` list and ensure no other
  plugin installs an answerer.
- **Wrong workspace root** — the default is `process.cwd()` of the
  harness process. If you launch `pnpm dsh web` from a different
  directory, set `workspace` in `cordis.yml` explicitly.
- **`Only URLs with a scheme in: file, data, and node … Received
  protocol 'd:'`** — the `name:` path in `cordis.yml` must be a
  `file://` URL, not a raw drive-letter path. This is the same
  constraint as every other scratch plugin.

## Why two seams?

It would be tempting to put everything inside the `approval/request`
listener (deny by returning `'rejected'` when the command looks
destructive). That has two problems:

1. The approval seam doesn't carry parsed tool arguments. The
   answerer only sees the tool name, reason, and call id — the
   command string is not exposed.
2. The approval seam is for "should we ask the human?", not for
   "is this safe?". Conflating the two would mean every safe
   tool that happens to call `ctx.approval.request` for unrelated
   reasons (e.g. a sub-agent that wants a clarification) would
   also be subject to the deletion check.

`tools/pre-execute` is the right layer for parsed-args policy; the
approval seam is the right layer for human-in-the-loop. This
plugin uses both, one job each.
