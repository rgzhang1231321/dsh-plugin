/**
 * bg-image 注入脚本生成。
 *
 * 生成两行 IndexInjection:
 *   1. style 行: 设置 body 背景图样式(在 <head> 中)。
 *   2. script 行: 注入切换按钮和图片切换逻辑(在 <body> 中)。
 */

import type { IndexInjection } from "@deepseek-ai/dsh-host-webserver";
import type { BgImageSettings } from "./settings";

/**
 * TODO: 实现这个函数
 *
 * 提示:
 *   - 守卫: settings.enabled 为 false 或 imageUrls 为空时返回 null
 *   - 用 settings.currentIndex 对 imageUrls.length 取模得到安全索引
 *   - 根据 settings.fitMode 决定 background-size:
 *     'cover' → 'cover', 'contain' → 'contain', 'repeat' → 'auto'
 *   - 根据 settings.fitMode 决定 background-repeat:
 *     'repeat' → 'repeat', 其他 → 'no-repeat'
 *   - 返回 { kind: 'style', text: css字符串 }
 *
 * @param settings - 当前 bg-image 配置(未使用是正常的,实现后去掉下划线前缀)
 * @returns IndexInjection style 行,如果未启用则返回 null
 */
export function buildBgImageStyleInjection(
  settings: BgImageSettings,
): IndexInjection | null {
  // 在这里实现你的代码
  if (!settings.enabled || settings.imageUrls.length === 0) return null;
  /**
   * currentIndex 可能被用户手动改过，或者持久化了一个超出范围的值（比如删除了某张图片后索引变了）。
用 %（取模）运算把索引约束在 [0, imageUrls.length - 1] 范围内，防止数组越界。
例如：imageUrls 有 3 张图，currentIndex 是 5 → 5 % 3 = 2，安全落到第 3 张。
  */
  const idx = settings.currentIndex % settings.imageUrls.length;
  const size =
    settings.fitMode === "cover"
      ? "cover"
      : settings.fitMode === "contain"
        ? "contain"
        : "auto";
  const repeat = settings.fitMode === "repeat" ? "repeat" : "no-repeat";
  const url = settings.imageUrls[idx];
  return {
    kind: "style",
    text: `/* bg-image: 背景图应用到聊天内容区域 */
.G4_6xa_scrollBody {
  background-image: url("${url}") !important;
  background-size: ${size} !important;
  background-repeat: ${repeat} !important;
  background-position: center !important;
  background-attachment: fixed !important;
  opacity: ${settings.opacity};
  filter: blur(${settings.blur}px);
}
/* 消息气泡透明 */
[class*="bubble"] {
  background-color: rgba(255, 255, 255, 0.15) !important;
  backdrop-filter: blur(2px);
}
/* 消息卡片透明 */
[class*="card"] {
  background-color: rgba(255, 255, 255, 0.1) !important;
}
/* 作曲家(输入框)区域透明 */
[class*="composerSeat"],
[class*="composerStack"],
[class*="composerCard"] {
  background: transparent !important;
}`,
  };
}

/**
 * TODO: 实现这个函数
 *
 * 提示:
 *   - 守卫: settings.enabled 为 false 或 imageUrls.length < 2 时返回 null
 *   - 用 JSON.stringify(settings.imageUrls) 把 URL 列表序列化为 JS 数组字面量
 *   - 用 IIFE (() => { ... })() 包裹脚本,避免污染全局作用域
 *   - 脚本逻辑:
 *     1. 设置 document.body.setAttribute('data-bg-image-enabled', 'true')
 *     2. 创建 button 元素,固定右下角定位
 *     3. 点击时 currentIndex = (currentIndex + 1) % imageUrls.length
 *     4. 动态插入 <style id="bg-image-dynamic"> 覆盖 background-image
 *     5. fetch('/api/bg-image/switch', { method: 'POST' }) 持久化
 *   - 返回 { kind: 'script', placement: 'body', text: script字符串 }
 *
 * @param settings - 当前 bg-image 配置(未使用是正常的,实现后去掉下划线前缀)
 * @returns IndexInjection script 行,如果未启用则返回 null
 */
export function buildBgImageToggleInjection(
  settings: BgImageSettings,
): IndexInjection | null {
  // 在这里实现你的代码
  if (!settings.enabled || settings.imageUrls.length < 2) return null;
  const urls = JSON.stringify(settings.imageUrls);
  return {
    kind: "script",
    placement: "body",
    text: `(() => {
  const imageUrls = ${urls}
  let currentIndex = ${settings.currentIndex % settings.imageUrls.length}

  document.body.setAttribute('data-bg-image-enabled', 'true')

  const btn = document.createElement('button')
  btn.textContent = '🖼️'
  Object.assign(btn.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '9999',
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(255,255,255,0.7)',
    cursor: 'pointer',
    fontSize: '20px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
  })

  btn.addEventListener('click', () => {
    currentIndex = (currentIndex + 1) % imageUrls.length
    let styleEl = document.getElementById('bg-image-dynamic')
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = 'bg-image-dynamic'
      document.head.appendChild(styleEl)
    }
    styleEl.textContent = \`.G4_6xa_scrollBody { background-image: url("\${imageUrls[currentIndex]}") !important; }\`
    fetch('/api/bg-image/switch', { method: 'POST' })
  })

  document.body.appendChild(btn)
})()`,
  };
}
