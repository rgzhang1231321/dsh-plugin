# bg-image 插件问题排查与解决记录

## 问题 1: 插件无法读取 cordis.patch.yml 配置

**现象**: 插件启动后背景图不显示,配置未生效。

**原因**: 尝试通过 `ctx.config` 读取 composition config,但 `Context` 类型上不存在 `config` 属性。

**解决**: Cordis 框架的插件 `apply` 函数签名为 `apply(ctx, config)`,第二个参数 `config` 就是 composition config(来自 `cordis.patch.yml` 的 `config` 块)。

```typescript
export function apply(ctx: Context, config?: Partial<BgImageSettings>): void {
  const settings: BgImageSettings = {
    ...DEFAULT_BG_IMAGE_SETTINGS,
    ...config,
  };
  // ...
}
```

---

## 问题 2: 背景图被客户端 CSS 覆盖

**现象**: 样式已注入到 `<head>`,但 `getComputedStyle(body).backgroundImage` 显示 `none`。

**原因**: 客户端 CSS 中 `body { background: var(--ds...); }` 使用了 `background` 简写属性,它会将 `background-image` 重置为 `none`,且因在文档中出现在我们的样式之后,覆盖了我们的 `background-image`。

**解决**: 在 `background-image` 等属性上添加 `!important`。

```css
.G4_6xa_scrollBody {
  background-image: url("...") !important;
  background-size: cover !important;
  background-repeat: no-repeat !important;
  background-position: center !important;
  background-attachment: fixed !important;
}
```

---

## 问题 3: 背景图闪烁后消失

**现象**: 页面刷新瞬间能看到背景图,客户端渲染后消失。

**原因**: 背景图应用到 `body`,但客户端 `.G4_6xa_root` 等容器有白色不透明背景,覆盖在 `body` 之上。

**解决**: 将背景图应用到更具体的聊天区域元素 `.G4_6xa_body`(即 `.G4_6xa_root` 的子元素),并让子元素透明。

```css
.G4_6xa_body {
  background-image: url("...") !important;
  background-size: cover !important;
}
```

---

## 问题 4: 消息卡片遮挡背景图

**现象**: 背景图显示了,但消息气泡和卡片有不透明背景色,看不到背景图。

**原因**: 消息气泡(`.CDuZwW_bubble`)背景为 `rgb(237, 243, 254)`,消息卡片(`.QOoLNa_card`)背景为 `rgb(255, 255, 255)`,均为不透明。

**解决**: 让消息卡片和气泡半透明,并添加毛玻璃效果。

```css
[class*="bubble"] {
  background-color: rgba(255, 255, 255, 0.15) !important;
  backdrop-filter: blur(2px);
}
[class*="card"] {
  background-color: rgba(255, 255, 255, 0.1) !important;
}
```

---

## 最终 DOM 结构关系

```
<body>                           ← 不在此处设置背景
  <div id="root">
    <div data-slot="root">
      <div data-slot="sidebar">  ← 侧边栏,不受影响
      <div data-slot="conversation">
        <div class="G4_6xa_root">  ← 已透明
          <div class="G4_6xa_body">  ← ✅ 背景图设置在这里
            <div class="G4_6xa_scrollBody">
              <div class="bubble">  ← 半透明毛玻璃
              <div class="card">    ← 半透明
```

## 配置示例 (~/.dsh/cordis.patch.yml)

```yaml
- id: bg-image
  name: "file:///d:/code/dsh/deepseek-harness/dsh_plugin/bg-image/src/index.ts"
  config:
    enabled: true
    imageUrls:
      - "https://example.com/bg1.png"
      - "https://example.com/bg2.png"
    currentIndex: 0
    fitMode: cover # cover | contain | repeat
    opacity: 1 # 0-1
    blur: 0 # px
```

## 关键经验

1. **CSS 调试要同时检查 DOM 和截图**: `getComputedStyle` 能确认样式是否生效,截图能确认实际视觉效果。
2. **`background` 简写会重置所有子属性**: 包括 `background-image`、`background-size` 等,使用时要注意被覆盖。
3. **`!important` 是覆盖第三方 CSS 的有效手段**: 当无法控制样式加载顺序时。
4. **选择器要精确到目标元素**: 避免应用到 body 等全局元素,容易被后续样式覆盖。
