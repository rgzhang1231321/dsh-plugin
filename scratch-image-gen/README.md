# image-gen (scratch plugin)

A user-level DeepSeek Harness plugin that exposes a single `image-gen` tool wrapping three external image generation providers:

| Provider | T2I | I2I | Sync? | I2I input format |
|---|---|---|---|---|
| **OpenAI** (`gpt-image-1` / `dall-e-3`) | ✅ | ✅ | sync | multipart PNG bytes |
| **Aliyun Bailian / DashScope** (`wanx-v1` / `wanx2.1-imageedit` / `qwen-image`) | ✅ | ✅ | **async** (submit + poll) | **public HTTPS URL only** |
| **MiniMax** (`image-01`) | ✅ | ✅ (`subject_reference`) | sync | URL or data URL |

> Status: MVP. The plugin is a self-contained directory registered as a pnpm workspace member; pnpm symlinks the harness packages it needs into `scratch-image-gen/node_modules/` so a plain-node (`:lib`) load from `cordis.yml` resolves them at runtime, and HMR reloads the plugin file in place while the Web UI runs.

## Layout

```
scratch-image-gen/
├── README.md
├── package.json              # workspace:* deps; required so pnpm can symlink
├── tsconfig.json             # type-check only; no emit
├── cordis.yml                # overlay entry — points to src/index.ts
└── src/
    ├── index.ts              # apply() wires settings + tool
    ├── settings.ts           # image-gen settings namespace
    ├── types.ts              # shared types (ProviderAdapter, GeneratedImage, …)
    ├── input.ts              # resolve URLs / file paths into provider-ready form
    ├── generate.ts           # dispatcher (pick adapter, call, save, attach)
    ├── providers/
    │   ├── base.ts           # retry, sleep, fetchJson, base64 helpers
    │   ├── openai.ts         # OpenAI adapter
    │   ├── bailian.ts        # DashScope adapter (async + poll)
    │   └── minimax.ts        # MiniMax adapter
    └── tools/
        └── image-gen.ts      # the `image-gen` tool
```

## Setup (one-time)

The scratch directory is a pnpm workspace member. After editing `pnpm-workspace.yaml` to include it, run from the repo root:

```sh
pnpm install
```

pnpm will symlink every workspace package declared in `scratch-image-gen/package.json` into `scratch-image-gen/node_modules/`. Plain Node can then resolve `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-settings`, etc. when the loader imports the plugin file.

## Run

From the repository root, with dependencies installed:

```sh
pnpm dsh web --patch ./scratch-image-gen/cordis.yml
```

The terminal logs `[image-gen] ready: providers=…` once the plugin finishes loading. Open `http://127.0.0.1:3080` and start a session.

> The plugin is hot-reloadable after the first start: edits to any `src/*.ts` file or to `cordis.yml` itself are picked up by HMR while the Web UI keeps running. You only need to restart for `package.json` changes or renaming `export const name`.

## Configure

Settings panel → `image-gen` namespace:

| Field | Default | Notes |
|---|---|---|
| `defaultProvider` | `openai` | One of: `openai`, `bailian`, `minimax`. |
| `defaultSize` | `1024x1024` | `1024x1024`, `16:9`, etc. Per-provider shape adaptation happens internally. |
| `defaultN` | `1` | 1..9 images per call. |
| `pollTimeoutMs` | `180000` | Bailian only — total poll time for the async task. |
| `bailianEditModel` | `wanx2.1-imageedit` | Bailian I2I default model. |
| `providers.openai.enabled` | `false` | |
| `providers.openai.apiKey` | `""` | `sk-…` |
| `providers.openai.baseUrl` | `https://api.openai.com` | |
| `providers.openai.model` | `gpt-image-1` | Also `dall-e-3`, `dall-e-2`, etc. |
| `providers.bailian.*` | (same shape) | Base URL default `https://dashscope.aliyuncs.com`, model `wanx-v1`. |
| `providers.minimax.*` | (same shape) | Base URL default `https://api.minimaxi.com/v1`, model `image-01`. |

Settings changes are picked up on the next tool call — no restart needed.

### Alternative: local JSON config file

If the Web UI's settings panel is unreachable (some web clients don't render the
`image-gen` namespace section), the plugin reads and watches a local JSON file
with the same shape as `ImageGenSettings`:

- `<cwd>/image-gen.json` — project-local, recommended
- `~/.dsh/image-gen.json` — user-level fallback

Only the keys you want to override are required; everything else inherits the
base defaults shown above. Example minimal file:

```json
{
  "providers": {
    "minimax": {
      "enabled": true,
      "apiKey": "sk-cp-…",
      "baseUrl": "https://api.minimaxi.com/v1",
      "model": "image-01"
    }
  }
}
```

The file is parsed at startup **and hot-reloaded on save** — `fs.watch` fires,
the plugin re-reads and calls `SettingsScope.replace(...)`, so subsequent tool
calls see the new values without a server restart.

## Try it

In a new session, after enabling and keying at least one provider, ask:

> 用 image-gen 画一张城市黄昏的图片,1024x1024。

The model should call the `image-gen` tool with `provider=openai` (or your default), `prompt=…`, `size=1024x1024`. The image renders inline in the chat and a copy is saved under `<cwd>/image-gen/image-<timestamp>-…-<seed>.png`.

For image-to-image:

> 用 image-gen 把 https://example.com/photo.jpg 改成水彩风格。

The tool picks the I2I path automatically when `images` is non-empty. For Bailian, the input **must** be a public HTTPS URL — local paths are rejected with a clear error.

## Provider notes

### OpenAI
- T2I: `POST {baseUrl}/v1/images/generations` → `data[].b64_json` (gpt-image-1 always base64).
- I2I: `POST {baseUrl}/v1/images/edits` with `multipart/form-data` (`image=PNG bytes`, `prompt`, `model`, optional `n`/`size`). The plugin reads your local file or downloads the URL and submits as PNG.
- gpt-image-1 requires `response_format=b64_json`; dall-e-3 returns URLs.

### Aliyun Bailian (DashScope)
- T2I: `POST {baseUrl}/api/v1/services/aigc/text2image/image-synthesis` (async submit).
- I2I: `POST {baseUrl}/api/v1/services/aigc/image2image/image-synthesis` (async submit). Requires `X-DashScope-Async: enable` header (always sent).
- Result URLs expire in 24h — the plugin downloads them to bytes immediately and never re-uses the URL.
- `base_image_url` **must** be a public HTTPS URL. Local file paths are rejected with a clear error.
- Poll pattern: every 3s for the first 30s, then every 6s, up to `pollTimeoutMs`.

### MiniMax
- T2I and I2I share one endpoint: `POST {baseUrl}/v1/image_generation`.
- I2I uses `subject_reference: [{type: 'character', image_file: <url or data URL>}]`.
- I2I's `subject_reference[].type` is currently fixed to `'character'` — MiniMax's I2I is "redraw this person in a new scene". For general style transfer / inpainting, use OpenAI or Bailian.

## Extending

- **New provider** → add `src/providers/<name>.ts` exporting a `ProviderAdapter`, register in `src/generate.ts`'s `ADAPTERS` map, add a `ProviderConfig` entry in `settings.ts`, and a new value to the `ProviderId` union in `types.ts`.
- **New image-to-image operation** → extend the `function` enum passed to the provider (Bailian) or `subject_reference.type` (MiniMax) by passing a tool argument through `generate.ts`.

## Troubleshooting

- **`Cannot find module '@deepseek-ai/...'` at runtime** — the scratch dir's `node_modules/` is empty. Run `pnpm install` from the repo root after editing `pnpm-workspace.yaml` to include the scratch dir.
- **`only URLs with a scheme in: file, data, and node are supported … Received protocol 'd:'`** — on Windows the `name:` field in `cordis.yml` must be a `file://` URL, not a raw drive-letter path.
- **`provider "X" is not enabled`** — open Settings → image-gen → providers.X, set `enabled=true` and fill `apiKey`.
- **`Bailian image-to-image requires a public HTTPS URL`** — Bailian does not accept local file paths. Upload the image to a CDN or use OpenAI / MiniMax for local-file I2I.
- **Bailian returns `current user api does not support synchronous calls`** — should not happen, the plugin always sends `X-DashScope-Async: enable`. If it does, file an issue.
- **MiniMax `1002 限流`** — back off and retry. The plugin already retries transient 429/5xx automatically.
- **Type errors when editing** — `npx tsc --noEmit -p scratch-image-gen/tsconfig.json` from the repo root.
