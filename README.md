# dsh-plugin

User-level plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Each subdirectory is a self-contained scratch plugin: drop it into your local
DSH checkout, register its workspace member in `pnpm-workspace.yaml`, run
`pnpm install`, and load it via `cordis.yml` or `~/.dsh/cordis.patch.yml`.

## Plugins

| Plugin | Role |
|---|---|
| [`scratch-wechat-article/`](scratch-wechat-article/) | Four-stage WeChat Official Account article pipeline (outline → draft → polish → title) plus an optional cover-image stage. Persists drafts to a `wechat_article_drafts` storage domain. |
| [`scratch-auto-approve/`](scratch-auto-approve/) | Auto-approves every `approval/request`, with a `tools/pre-execute` gate that rejects bash-style deletion commands whose target paths fall outside the configured workspace. |

## How a scratch plugin fits the harness

A scratch plugin is just a directory the user puts inside the harness repo
and registers as a pnpm workspace member. The harness's `pnpm-workspace.yaml`
already covers `scratch-*` directories at the repo root, so once you clone
this repo's contents into `deepseek-harness/`, the workspace pattern picks
them up:

```yaml
# deepseek-harness/pnpm-workspace.yaml (already ships this glob)
packages:
  - scratch-*
```

`pnpm install` symlinks the workspace packages (`@deepseek-ai/dsh-tools`,
`@deepseek-ai/dsh-llm`, etc.) into each plugin's `node_modules/`. From
then on, a plain-node load from `cordis.yml` can `import` those packages
at runtime.

## Loading the plugins

Either pass a one-off `--patch` overlay when you boot DSH, or persist
the patches in your home directory. Each plugin ships a `cordis.yml`
with an `insert` block ready to use.

### One-off load

```sh
cd path/to/deepseek-harness
pnpm dsh web \
  --patch ./scratch-wechat-article/cordis.yml \
  --patch ./scratch-auto-approve/cordis.yml
```

### Persistent load

Append the same `insert` blocks to `~/.dsh/cordis.patch.yml` (created
if absent). The harness HMR-watches that file, so subsequent boots
need no `--patch` and live edits apply without restart.

```yaml
# ~/.dsh/cordis.patch.yml
- insert:
    - id: wechat-article
      name: 'file:///ABSOLUTE/PATH/TO/scratch-wechat-article/src/index.ts'
- insert:
    - id: auto-approve
      name: 'file:///ABSOLUTE/PATH/TO/scratch-auto-approve/src/index.ts'
      config:
        workspace: '/ABSOLUTE/PATH/TO/YOUR/WORKSPACE'
        enforceWorkspaceBoundary: true
        allowOutsideWorkspace: []
```

> The `name:` field MUST be a `file://` URL — on Windows, raw `d:/...`
> is rejected by Node's internal ESM loader as protocol `'d:'`. See
> each plugin's README for details.

## Editing the path inside each `cordis.yml`

The shipped `cordis.yml` files are written for the original author's
machine and use hardcoded absolute paths. Before running them on a
different machine, edit the `name:` field (and the `auto-approve`
`config.workspace` field) to point at the local checkout.

For a more portable setup, replace the hardcoded path with a `!!js`
expression that derives the URL from the harness's `process.cwd()`:

```yaml
- insert:
    - id: wechat-article
      name: !!js |
        new URL('scratch-wechat-article/src/index.ts',
                'file://' + process.cwd().replace(/\\/g, '/') + '/').href
```

YAML has no variables, so the `!!js` form is the only way to keep a
single patch file machine-independent.

## Hot reload

After the first successful boot, every file under `src/` and the
`cordis.yml` overlay is HMR-watched. Edits apply to the running Web
UI without a restart. You only need to restart when you touch
`package.json` (dependency change) or the plugin's `name:` export
(rename).

## Type checking

Each plugin's `tsconfig.json` is `noEmit` and inherits the harness's
`tsconfig.base.json` (strict + `noUncheckedIndexedAccess`). Run
type checking for an individual plugin from the harness root:

```sh
npx tsc --noEmit -p scratch-wechat-article/tsconfig.json
npx tsc --noEmit -p scratch-auto-approve/tsconfig.json
```

Errors in `vendor/cordis/` and `vendor/schemastery/` are pre-existing
framework issues and are not caused by these plugins.

## Plugin development

Both plugins were developed as scratch plugins — for the design
constraints and the rationale behind the workspace-member pattern,
see the `dsh` docs in the harness repository (in particular
`docs/user/develop/basic/index.zh.md`).
