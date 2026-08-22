# wechat-article (MVP)

A user-level DeepSeek Harness plugin that turns a one-line topic into a
structured WeChat Official Account article through a four-stage sub-agent
pipeline: **outline → draft → polish → titles**. Drafts persist to the
host's storage backend, so they survive restarts.

> Status: MVP. The plugin is a self-contained directory registered as a
> pnpm workspace member; pnpm symlinks the harness packages it needs
> into `scratch-wechat-article/node_modules/` so a plain-node (`:lib`)
> load from `cordis.yml` resolves them at runtime, and HMR reloads the
> plugin file in place while the Web UI runs.

## Layout

```
scratch-wechat-article/
├── README.md
├── package.json              # workspace:* deps; required so pnpm can symlink
├── tsconfig.json             # type-check only; no emit
├── cordis.yml                # overlay entry — points to src/index.ts
└── src/
    ├── index.ts              # apply() wires every module
    ├── settings.ts           # `wechat-article` settings namespace
    ├── storage.ts            # drafts storage-domain spec
    ├── section.ts            # style/tone system-prompt section
    ├── personas.ts           # 4 stage-specific system prompts
    ├── types.ts              # DraftRow / DraftSummary
    ├── subagents/
    │   ├── index.ts          # batch register
    │   └── provider.ts       # WechatSubagentProvider
    └── tools/
        ├── article.ts        # orchestration tool
        └── list-drafts.ts    # draft listing tool
```

## Setup (one-time)

The scratch directory is a pnpm workspace member. After editing
`pnpm-workspace.yaml` to include it, run from the repo root:

```sh
pnpm install
```

pnpm will symlink every workspace package declared in
`scratch-wechat-article/package.json` into
`scratch-wechat-article/node_modules/`. Plain Node can then resolve
`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, etc. when the loader
imports the plugin file.

## Run

From the repository root, with dependencies installed (`pnpm install`):

```sh
pnpm dsh web --patch ./scratch-wechat-article/cordis.yml
```

The terminal logs `[wechat-article] ready: …` once the plugin finishes
loading. Open `http://127.0.0.1:3080` and start a session.

> The plugin is hot-reloadable after the first start: edits to any
> `src/*.ts` file or to `cordis.yml` itself are picked up by HMR while
> the Web UI keeps running. You only need to restart for `package.json`
> changes, storage-domain schema migrations, or renaming `export const
> name`. See the HMR table in `Troubleshooting` below.

## Try it

In a new session, ask:

> 用 wechat-article 写一篇关于「远程办公对团队信任的影响」的文章，风格用 storytelling，目标 1500 字。

The model should call the `wechat-article` tool. You'll see four child
sub-agent sessions spawn in sequence (outline → draft → polish → title);
the orchestrator waits for each to finish before kicking off the next.
The terminal in the Web UI will render the full draft plus five title
candidates.

Then ask:

> 列出最近生成的所有草稿。

The model should call `wechat-list-drafts`.

## Configure

Settings panel → `wechat-article` namespace:

| Field | Default | Notes |
|---|---|---|
| `style` | `deep-analysis` | One of: `deep-analysis`, `storytelling`, `opinion`. |
| `targetLength` | `2000` | Target character count for the draft stage. |
| `tone` | `warm` | One of: `warm`, `professional`, `casual`. |
| `model` | `deepseek-chat` | LLM model id used by every sub-agent. |

Settings changes are picked up by the next prompt assembly — no
restart needed.

## How it works

- The `wechat-article` tool is the only entry the model calls. It runs
  the four stages sequentially, each as a fresh foreground sub-agent,
  disposing the child between stages so each starts from a clean
  context.
- Each sub-agent is a thin `WechatSubagentProvider` registered under
  `wechat-outline` / `wechat-draft` / `wechat-polish` / `wechat-title`.
  The persona string is attached to the `SubagentStartRequest`, which
  the in-process driver installs as a scoped `deployment:persona`
  section on the child.
- The polished draft and the title list are written to a `wechat-
  article-drafts` storage domain. The `KvTable` is opened in
  `index.ts` and disposed when the plugin fiber unloads.
- The `wechat-article:style` system-prompt section reflects the active
  style/tone so the rest of the agent stays aligned even when the model
  doesn't go through the dedicated tool.

## Extending

- New stage → add an entry to `subagents/index.ts` and a persona in
  `personas.ts`, then add a `runStage` call in `tools/article.ts`.
- New setting → extend `Schema` and the `WechatSettings` interface in
  `settings.ts`. The `section.ts` `text` callback re-reads the scope on
  every prompt assembly, so no manual refresh is needed.
- Cover-image generation → add a `ctx.web` (or new seam) provider
  plugin and call it after the title stage.

## Troubleshooting

- **Plugin doesn't appear in the loader log** — check the
  `cordis.yml` path. The plugin path must be absolute, and the file
  must be inside the watch root (default `.` of the harness cwd). HMR
  excludes `node_modules` and `.git`.
- **`Cannot find module '@deepseek-ai/...'` at runtime** — the scratch
  dir's `node_modules/` is empty. Run `pnpm install` from the repo
  root after editing `pnpm-workspace.yaml` to include the scratch dir.
- **`Only URLs with a scheme in: file, data, and node are supported …
  Received protocol 'd:'`** — on Windows the `name:` field in
  `cordis.yml` must be a `file://` URL, not a raw drive-letter path.
  Write `file:///d:/code/dsh/deepseek-harness/scratch-wechat-article/src/index.ts`,
  not `d:/code/dsh/deepseek-harness/...`. The Linux-style absolute path
  in `docs/user/develop/basic/` only works on POSIX systems.
- **`listen EADDRINUSE: 127.0.0.1:3080`** — another `dsh web` is still
  bound to the port. On Windows: `netstat -ano | findstr :3080` to get
  the PID, then `taskkill /F /PID <pid>`. The previous run's plugin
  state is already lost, so a clean restart is fine.
- **`subagent "wechat-outline" is not registered`** — the sub-agent
  providers are registered in `apply()`; if a sub-agent is started
  before apply finishes, the call fails. The current `apply()` is
  `async`; if a user-level call site reaches the tool before the
  plugin is fully mounted, restart the Web UI.
- **Drafts disappear after restart** — the storage host picks a
  backend from the deployment configuration. If you ran with one
  backend and switched to another, drafts will not follow. Check
  `~/.config/dsh/storage.json` (or the equivalent) for the active
  backend.
- **Type errors when editing** — the scratch directory is outside the
  monorepo's TS project graph. Run `npx tsc --noEmit -p scratch-wechat-article/tsconfig.json`
  from the repo root to type-check it in isolation. Errors in
  `vendor/cordis/` are pre-existing framework issues and are not caused
  by this plugin.
- **`domain name 'X' must match /^[a-z][a-z0-9_]*$/`** — the storage
  domain name only accepts lowercase letters, digits, and underscores.
  Replace any hyphens in `defineDomain({ name: '...' })`.
