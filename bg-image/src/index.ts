/**
 * bg-image 插件入口。
 *
 * 功能: 为 DSH Web UI 页面 body 设置可配置的背景图,并支持手动切换图片。
 *
 * 加载顺序(由 cordis 拓扑保证):
 *   1. webServer — 注册 index-inject,注入背景图样式和切换按钮。
 *
 * 配置项(通过 ~/.dsh/cordis.patch.yml 的 config 块):
 *   - imageUrls: string[]  — 背景图 URL 列表
 *   - currentIndex: number — 当前显示的图片索引
 *   - fitMode: 'cover' | 'contain' | 'repeat' — 图片适配模式
 *   - opacity: number      — 背景图不透明度 (0-1)
 *   - blur: number         — 背景模糊半径(px)
 *   - enabled: boolean     — 是否启用背景图
 */

import type { Context } from "@deepseek-ai/cordis";
import type { IndexInjection } from "@deepseek-ai/dsh-host-webserver";
import type { BgImageSettings } from "./settings";
import { DEFAULT_BG_IMAGE_SETTINGS } from "./settings";
import {
  buildBgImageStyleInjection,
  buildBgImageToggleInjection,
} from "./boot-bg-image";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

/**
 * 将本地文件路径转换为 base64 data URI。
 * 支持格式:
 *   - file:///D:/tmp/x.png
 *   - D:/tmp/x.png 或 /tmp/x.png
 *   - 已经是 http(s):// 或 data: 开头的路径直接返回
 *
 * @param url - 图片 URL 或本地路径
 * @returns data URI 或原始 URL
 */
function resolveImageUrl(url: string): string {
  // 已经是 web URL 或 data URI,直接返回
  if (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("data:")
  ) {
    return url;
  }

  // 移除 file:// 前缀
  let filePath = url;
  if (filePath.startsWith("file://")) {
    filePath = filePath.slice("file://".length);
    // file:///D:/tmp → D:/tmp (移除开头的第三个 /)
    if (filePath.startsWith("/") && /^\/[A-Za-z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }
  }

  // 根据扩展名确定 MIME 类型
  const ext = extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
  };
  const mime = mimeMap[ext] ?? "image/png";

  try {
    const buffer = readFileSync(filePath);
    const base64 = buffer.toString("base64");
    return `data:${mime};base64,${base64}`;
  } catch (err) {
    console.warn(`[bg-image] failed to read file "${filePath}": ${err}`);
    return url; // 读取失败时返回原始值,浏览器会显示 broken image
  }
}

/** 解析所有图片 URL,将本地路径转为 data URI */
function resolveAllImageUrls(urls: string[]): string[] {
  return urls.map(resolveImageUrl);
}

export const name = "bg-image";

export const inject = ["webServer"] as const;

export function apply(ctx: Context, config?: Partial<BgImageSettings>): void {
  // ─── 第一步: 合并配置 ─────────────────────────────────────────
  // config 参数来自 cordis.patch.yml 中该插件行的 `config` 块。
  //
  // 用默认值作为基础,用户配置覆盖默认值。
  const settings: BgImageSettings = {
    ...DEFAULT_BG_IMAGE_SETTINGS,
    ...config,
  };

  // 可变状态: 当前图片索引。点击切换按钮时递增。
  // 注意: 这个变量在内存中,重启后回到 config 中的 currentIndex。
  let currentIndex = settings.currentIndex;

  // ─── 第二步: 注册 HTTP route ───────────────────────────────────
  // 为什么需要 HTTP route?
  //   - 内联脚本运行在浏览器中,无法直接访问插件内部状态。
  //   - 通过 fetch 调用 Host route 是最简单的跨边界通信方式。
  //   - Host 端处理 currentIndex 的循环递增。
  //
  // route: POST /api/bg-image/switch
  // 响应: { ok: true, newIndex: number } 或 { ok: false, error: string }
  ctx.webServer.register({
    kind: "exact",
    path: "/api/bg-image/switch",
    handler: (_req, res) => {
      // 守卫: 未启用或图片少于 2 张时无需切换。
      if (!settings.enabled || settings.imageUrls.length < 2) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: "not enough images or disabled" }),
        );
        return;
      }

      // 循环到下一张。
      currentIndex = (currentIndex + 1) % settings.imageUrls.length;

      // 立即返回新索引,前端可以即时更新视觉。
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, newIndex: currentIndex }));
    },
  });

  // ─── 第三步: 监听 index-inject 事件 ────────────────────────────
  // 'webserver/index-inject' 是 webserver 插件在每次渲染 index.html 时
  // 发出的 emit 事件。插件通过往 table 里 push 行来注入样式/脚本。
  // ctx.on() 是 effect — 插件卸载时自动移除监听器。
  //
  // 注意: resolveAllImageUrls 放在这里而非 apply() 中,是为了每次页面
  // 加载时重新读取磁盘上的图片文件。这样修改图片后只需刷新页面,无需重启。
  ctx.on("webserver/index-inject", (table: IndexInjection[]) => {
    // resolveAllImageUrls 放在这里而非 apply() 中,是为了每次页面
    // 加载时重新读取磁盘上的图片文件。这样修改图片后只需刷新页面,无需重启。
    const resolved: BgImageSettings = {
      ...settings,
      imageUrls: resolveAllImageUrls(settings.imageUrls),
    };

    // ─── 注入背景图样式 ─────────────────────────────────────────
    // buildBgImageStyleInjection 返回 { kind: 'style', text: '...' },
    // 它会被渲染到 <head> 中,在页面首屏渲染前生效。
    const styleRow = buildBgImageStyleInjection({
      ...resolved,
      currentIndex,
    });
    if (styleRow) table.push(styleRow);

    // ─── 注入切换按钮脚本 ───────────────────────────────────────
    // buildBgImageToggleInjection 返回 { kind: 'script', placement: 'body', text: '...' },
    // 它会被渲染到 <body> 末尾,此时 DOM 已解析,可以安全操作 document.body。
    const toggleRow = buildBgImageToggleInjection({
      ...resolved,
      currentIndex,
    });
    if (toggleRow) table.push(toggleRow);
  });
}
