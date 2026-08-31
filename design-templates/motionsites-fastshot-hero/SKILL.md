---
name: motionsites-fastshot-hero
description: MotionSites Fastshot 风格的单屏 AI 应用生成器营销 Hero，以全屏风景视频、玻璃拟态 composer、精准响应式工具栏和克制的一次性入场动效呈现。
triggers:
  - "Fastshot hero"
  - "AI app builder landing page"
  - "video background marketing hero"
  - "glass composer landing page"
od:
  mode: prototype
  platform: desktop
  scenario: marketing
  preview:
    type: html
    entry: example.html
  design_system:
    requires: false
  outputs:
    primary: index.html
  capabilities_required: [file_write]
---

# MotionSites Fastshot Hero

创建一个无构建步骤、可直接打开的单文件营销 Hero 原型。

## 工作流

1. 开始前完整读取同目录下的 `example.html` 和 `references/source-prompt.md`。
2. 以 `example.html` 为实现基线复制到输出的 `index.html`，保留单屏结构、全屏背景视频、玻璃 composer、导航、proof logos、响应式架构和一次性入场动效。
3. 根据用户需求替换品牌名称、headline、导航文案、composer 示例文案、CTA 和 proof 内容；不要保留与新品牌无关的 Fastshot 文案。
4. 保持原模板的视觉语言和动效节奏：暗色全屏影像、白色文字、紫色圆形品牌标记、深色玻璃卡片、橙色发送按钮，以及 desktop/tablet/phone 三套工具栏布局。
5. 背景视频默认继续使用 `./assets/background.mp4`，字体继续使用 `./assets/fonts/inter-latin-variable.woff2`；输出时必须保留这两个本地资产及相对路径。仅当用户明确提供替代媒体时才更换，并继续保证 `autoplay muted loop playsinline`、全屏 cover、无平移缩放。
6. 不增加第二个 section、额外页面、滚动叙事或循环入场动画。所有交互元素继续保留清晰的 `:focus-visible`，重要可编辑区域继续保留 `data-od-id`。
7. 输出必须是独立 `index.html`，CSS 与 JavaScript 内联，不依赖打包、框架或构建步骤；资产路径使用可随模板一起复制的相对路径。

## 必须保留的布局约束

- Desktop composer 的右侧 model、paperclip、send cluster 必须使用模板中的绝对定位；不能改成居中 flex。
- Tablet 工具栏保持单行 flex，chips 在左、右侧 controls 靠右。
- Phone 工具栏为两行：chips 在第一行，model 在第二行左侧，paperclip 与 send 靠右。
- 移动导航继续使用 checkbox + label 的 CSS-only 菜单。
- 入场动效仅首屏执行一次，并尊重 `prefers-reduced-motion`。

## Bundled font assets

Keep `assets/fonts/` with every copied or generated template. Preserve the existing local `@font-face` declaration and its relative font URL. Do not add remote font stylesheets, font preconnects, remote `@import` rules, or remote `@font-face` URLs.
