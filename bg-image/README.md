# bg-image 插件 / bg-image Plugin

为 DSH Web UI 的聊天区域添加可配置的背景图，支持手动切换图片。

Adds a configurable background image to the DSH Web UI chat area, with manual image cycling.

---

## 功能 / Features

- 为聊天对话框区域设置背景图 / Set background image for the chat dialog area
- 支持多张图片配置 / Support multiple image configuration
- 浮动按钮手动切换图片 / Floating button to manually switch images
- 支持本地文件和网络 URL / Support both local files and network URLs
- 可配置适配模式、透明度、模糊 / Configurable fit mode, opacity, and blur
- 修改图片后刷新页面即可生效 / Refresh page to apply image changes (no restart needed)

---

## 安装 / Installation

在 `~/.dsh/cordis.patch.yml` 中添加插件：

Add the plugin in `~/.dsh/cordis.patch.yml`:

```yaml
- id: bg-image
  name: 'file:///d:/code/dsh/deepseek-harness/dsh_plugin/bg-image/src/index.ts'
  config:
    enabled: true
    imageUrls:
      - "file:///D:/tmp/bg1.png"
      - "https://example.com/bg2.png"
    currentIndex: 0
    fitMode: cover
    opacity: 1
    blur: 0
```

---

## 配置说明 / Configuration

| 字段 / Field | 类型 / Type | 说明 / Description |
|---|---|---|
| `enabled` | `boolean` | 是否启用背景图 / Enable background image |
| `imageUrls` | `string[]` | 图片路径列表（支持 `file://`、绝对路径、`http(s)://`）/ Image paths (`file://`, absolute path, `http(s)://`) |
| `currentIndex` | `number` | 默认显示的图片索引 / Default image index |
| `fitMode` | `'cover' \| 'contain' \| 'repeat'` | 图片适配模式 / Image fit mode |
| `opacity` | `number` (0-1) | 背景图不透明度 / Background opacity |
| `blur` | `number` (px) | 背景模糊半径 / Background blur radius |

### 图片路径格式 / Image Path Formats

```yaml
# 本地文件（自动转为 base64）/ Local file (auto-converted to base64)
imageUrls:
  - "file:///D:/tmp/x.png"
  - "D:/tmp/x.png"           # 绝对路径也支持 / Absolute path also works

# 网络图片 / Network image
imageUrls:
  - "https://example.com/bg.png"
```

### 适配模式说明 / Fit Mode

| 模式 / Mode | 效果 / Effect |
|---|---|
| `cover` | 等比缩放，完全覆盖区域（可能裁剪）/ Scale to cover (may crop) |
| `contain` | 等比缩放，完整显示（可能留空）/ Scale to fit (may letterbox) |
| `repeat` | 平铺重复 / Tile repeatedly |

---

## 使用方式 / Usage

1. 配置 `~/.dsh/cordis.patch.yml`（见上方示例）
2. 启动或重启 `pnpm dsh web`
3. 打开浏览器访问 DSH Web UI
4. 如果配置了 ≥2 张图片，右下角会出现 🖼️ 按钮
5. 点击按钮切换下一张图片

---

1. Configure `~/.dsh/cordis.patch.yml` (see example above)
2. Start or restart `pnpm dsh web`
3. Open browser and visit DSH Web UI
4. If ≥2 images are configured, a 🖼️ button appears at bottom-right
5. Click the button to cycle to the next image

---

## 修改图片 / Modifying Images

修改磁盘上的图片文件后，**刷新浏览器页面**即可看到新图片，无需重启服务端。

After modifying the image file on disk, **refresh the browser page** to see the new image. No server restart needed.

---

## 文件结构 / File Structure

```
bg-image/
├── src/
│   ├── index.ts          # 插件入口 / Plugin entry
│   ├── settings.ts       # 配置定义与 schema / Config definition & schema
│   └── boot-bg-image.ts  # CSS/脚本注入生成 / CSS & script injection
├── package.json
├── tsconfig.json
└── DEBUG-NOTES.md        # 开发调试记录 / Development debug notes
```
