# DSH PSD Batch Studio · 主图批量替换工作台

**简体中文 | [English](README.en.md)**

> 由 **Genca（缙嘉集团，上海缙嘉科技有限公司）VinkWork 团队** 开源。
> VinkWork 的核心产品是 [VinkClaw.com](https://vinkclaw.com)。

一个 [DeepSeek Harness](https://github.com/deepseek-ai) 插件，用来批量生产电商商品主图：
载入 PSD/PSB 主图模板，标记商品槽位，批量放入 SKU 抠图，在画布上微调，最后一键整批导出。

同一套合成内核还提供两个 agent 工具，可以让 agent 在 Host 侧无人值守地跑完整个 SKU 目录。

> **协议：** 修改版 Apache License 2.0，带附加条件。
> 允许商用；多租户服务或去除品牌标识需要书面授权。详见 [LICENSE](LICENSE) 与 [LICENSING.md](LICENSING.md)。

## 适用对象

适合已经有 PSD 主图模板、又需要批量产出变体的电商设计与运营团队。PSD 仍然是唯一事实来源：
插件只替换商品像素，保留模板里的文字、价格条、角标、赠品卡等装饰层，最后输出成品图。

它**不是** Photoshop 替代品：不负责改文案、修图、管理素材库；它负责“模板 + 抠图 → 成品主图变体”。

## 适用场景

- **大促/活动批量出图**：一个模板 × 几百个 SKU（618、双 11、黑五、店铺全场活动），
  或者一批 SKU × 多个活动模板；换模板时 SKU 队列保留，不用重新导入。
- **新品上新**：一个模板，多个颜色/规格/组合装变体，在同一组商品位里重新适配。
- **多平台/多尺寸**：天猫、京东、抖音、拼多多，或方图、竖图、长图的模板集合；
  换模板不用重搭流程。
- **设计到运营的交接**：设计师交付 PSD 和槽位规则，运营/代运营/店长自己批量出图，不再排队等设计。
- **Agent 自动化**：`psd_batch_render` 在工作区里无人值守批量渲染，适合夜间任务、商品库对接、
  “明早之前出 200 张”这类需求。
- **模板治理**：文案、角标、价格条、活动道具分图层管理，按活动开关；商品位保持稳定。

一次典型运行：

```text
templates/summer-main.psd + skus/0715/*.png
        ↓  商品槽位替换
out/0715-main/*.jpg（可选 ZIP）
```

## 功能

- **模板工作台**：打开 `.psd` / `.psb`，浏览图层树、开关图层，在交互画布上实时看合成结果。
- **商品槽位**：按面积、位置、长宽比和命名自动推荐商品图层；可手动标记/取消。
  同一商品的「原层 + 阴影/高光副本」会组成一个商品簇，一起隐藏、商品只画一次。
- **批量适配**：一次导入多张 PNG/JPG/WebP 抠图，自动裁掉透明边，按
  完整放入 / 按高度 / 按宽度 / 铺满裁切适配，并支持对齐和占比。
- **画布微调**：拖动商品、拖角点缩放、数值调偏移/缩放/角度，可一键同步到全部 SKU。
- **导出**：按模板原始分辨率输出 JPG/PNG，每个 SKU 一张，可打包 ZIP。
- **Agent 工具**：`psd_inspect`、`psd_batch_render`，同一套内核在 Host 侧批量跑。
- **本地优先**：PSD 解析和合成都在本机完成（页面内或 Host 进程），没有网络请求、没有埋点、不上传素材。

## 环境要求

- DeepSeek Harness（带插件管理器），dsh `0.2.0-rc.2` 及以上（`dsh.engines.dsh >= 0.2.0-rc.2`）。
  - 桌面版 0.2.0-rc.2（内置 dsh 0.2.0-rc.2、pnpm 11.7.0）实机验证：从 GitHub 安装、冷启动激活、
    面板渲染、两个 agent 工具注册，并在真实 PSD 上跑通。
  - dsh `0.2.1-rc.5` 和 `0.2.2-rc.1`：用对应版本的 `@deepseek-ai/dsh-tools` 校验工具注册和 schema。
    这两个版本提供 `workingDirectory` 服务，工具优先用它定位会话工作区；0.2.0 没有这个服务，
    改用会话自身的工作目录。
  - 0.2.5 的 agent 工具在所有 dsh 版本上都注册不上（[#7](https://github.com/vinkwork/dsh-psd-batch-studio/issues/7)），请勿使用。
- Node.js 20+（构建和 Host 侧 agent 工具需要）。
- 安装时需要能访问 npm registry：agent 工具依赖 `@napi-rs/canvas` 的平台预编译包。
- 不需要安装 Photoshop。

## 安装

从 npm 安装（推荐）：

```text
plugin_manager install_bundle, target = dsh-psd-batch-studio
```

固定版本用 `dsh-psd-batch-studio@0.2.6`。

也可以从 GitHub 安装：

```text
plugin_manager install_bundle, target = github:vinkwork/dsh-psd-batch-studio
```

pnpm 会把 GitHub 依赖锁定到安装时的 commit；仓库更新后要重新安装才会生效。要装某个分支或 commit，
在后面加 `#分支名` 或 `#commit`。

如果插件管理器不支持 GitHub spec，克隆后指向本地目录：

```bash
git clone https://github.com/vinkwork/dsh-psd-batch-studio.git
cd dsh-psd-batch-studio
npm install
```

```text
plugin_manager install_bundle, target = /绝对路径/dsh-psd-batch-studio
```

安装后刷新 Harness 页面：侧边栏出现「主图批量替换」图标，agent 侧出现两个工具。

`client.js` / `server.js` 已随仓库提交，安装不需要先构建；改源码后执行 `npm run build`。

## 使用工作台

1. 从侧边栏打开「主图批量替换」。
2. 载入 `.psd` / `.psb`，左侧出现图层树，自动识别的商品位用虚线框标出。
3. 在图层树确认槽位：◎ 切换商品位，眼睛图标开关该层是否参与合成；大模板可用搜索框。
4. 导入 SKU 抠图，在右侧选择一张即可在画布所有槽位预览。
5. 调适配方式、对齐、占比、偏移、缩放、角度；「同步到全部」把当前微调套到所有 SKU。
6. 选 JPG/PNG，整批导出，可顺带打 ZIP。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `psd_inspect` | 返回模板尺寸、图层树（名称/层级/可见性/边界/图层 id）、自动识别的商品槽位；文字层额外返回文案和逐段字体样式（字体/字重/字号/颜色）。 |
| `psd_batch_render` | 把一批 SKU 套进模板，输出 JPG/PNG（可选 ZIP）到工作区；结果里的 `suppressed` 列出随槽位一起隐藏的同组重叠图层。 |

调用示例：

```json
{
  "template": "templates/summer-main.psd",
  "skuDir": "skus/0715",
  "outDir": "out/0715-main",
  "format": "jpg",
  "fit": "contain",
  "anchor": "center",
  "adjustments": {
    "sku-001": { "dy": -14, "scale": 1.03 }
  },
  "zip": true
}
```

两个工具的路径都相对当前会话工作目录解析，并拒绝越界路径。`psd_batch_render` 默认 JPG、质量 92，
返回输出目录和前 50 个文件名。

槽位所在的组里，其它「可见且与槽位重叠 ≥25%」的图层会随槽位一起隐藏（旧商品图、没对齐的
影子层最常见），否则新 SKU 会在旧商品的像素上叠加出「两个商品」。被隐藏的图层会在结果里以
`suppressed` 列出；刻意的压在商品上的装饰请放到其他组里。近乎完全重叠且大小一致的堆叠副本
（阴影/高光）仍走原有槽位簇逻辑，槽位适配框不受影响。

## 构建

```bash
npm install
npm run build
```

测试：

```bash
npm test
```

`npm test` 先跑冒烟测试（生成临时 PSD，检查合成、槽位和导出），再跑 Host 契约测试：用 dsh 自己的
`@deepseek-ai/dsh-tools` 校验器（锁定桌面版内置的 0.2.0-rc.2）注册全部 agent 工具，检查 schema 是否在
dsh 支持的子集内、`output.render` 是否齐全、真实返回值是否符合输出 schema，以及有无 `workingDirectory`
服务时的工作区解析。改了工具参数或返回结构后务必跑一遍：schema 不合规时 dsh 会在注册阶段直接拒绝，
所有工具都不可用。

## 常见问题

**安装时报 `ERR_PNPM_UNEXPECTED_STORE`。** 这是本机环境问题，与插件无关：profile 的
`node_modules` 曾用另一个大版本的 pnpm 装过（例如终端里的 pnpm 10），而 Harness 桌面版用内置的
pnpm 11，两者的 store 不能混用。把 `~/.dsh/profiles/<profile>/node_modules` 挪开备份，再在 Harness
里重新安装即可。以后不要用终端里的 pnpm 往 profile 目录装东西。

**插件装上了，但 agent 里没有 `psd_inspect` / `psd_batch_render`。** 先确认插件版本不是 0.2.5：
该版本的工具 schema 不符合 dsh 的要求，在所有 dsh 版本上都注册不上
（[#7](https://github.com/vinkwork/dsh-psd-batch-studio/issues/7)），请升级。同一个 profile 里
也不要同时挂两份本插件（例如旧的本地安装加 GitHub 版），它们使用同一个 `psd-batch-studio` 条目。

## 已知限制

- 文字层使用 PSD 里的栅格像素，暂不支持在工具里改文案/字体。
- 斜面和浮雕、内阴影为近似或跳过；描边/投影/发光为近似。
- 一次处理一个模板；「多模板 × 多 SKU」矩阵尚未内置，换模板时 SKU 队列会保留。
- 几百 MB 的 PSB 需要几百 MB 内存；建议用桌面端或 Host 批量路径。
- Host 工具依赖 `@napi-rs/canvas`；某个平台加载不了原生包时，页面工作台仍可用，agent 工具不可用。

## 项目与协议

- 维护团队：Genca（缙嘉集团，上海缙嘉科技有限公司）VinkWork 团队。
- VinkWork 核心产品：<https://vinkclaw.com>
- 问题反馈：<https://github.com/vinkwork/dsh-psd-batch-studio/issues>
- 源码：<https://github.com/vinkwork/dsh-psd-batch-studio>

Copyright (c) 2026 上海缙嘉科技有限公司（Genca）。

代码以 **修改版 Apache License 2.0** 发布，附加条件如下：

- 允许商用，包括企业内部使用、作为其他应用的后端或企业应用开发平台；
- 运营多租户服务，或去除/修改前端版权信息、项目名称、Genca/VinkWork 署名，需要上海缙嘉科技有限公司（Genca）的书面商业授权；
- 贡献者同意：官方可以调整协议（更严或更松），贡献代码可被用于商业用途。

完整条款见 [LICENSE](LICENSE)，未修改的 Apache 2.0 原文见 [LICENSE-APACHE](LICENSE-APACHE)。
v0.1.2 及更早版本仍按 PolyForm Noncommercial 1.0.0 发布，适用其原始条款。第三方 MIT 声明见
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。
