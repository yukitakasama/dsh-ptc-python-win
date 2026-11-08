# Upstream issue: `run_code` cards hard-code the TypeScript language

> 状态：建议草稿（未提交上游）。对应本包的临时客户端覆盖见 `docs/gui-language-badge.md`。
> 观察版本：DSH `0.2.2-rc.1`。

## 摘要

`tool-executor-ptc` 支持 `typescript` 与 `python` 两种 runtime language，模型侧 schema 和 SDK 渲染都按 `runtime.language` 正确切换，但 Web GUI 的聊天卡片仍然把每个 `run_code` 程序显示成 `typescript`。原因是客户端把语言写死了：`@deepseek-ai/dsh-client-ui-tool` 的 `code` 变体固定使用 `lang: "typescript"`，而调用侧 `presentCall` 的渲染意图（`GenericCallView`）没有语言字段可传。

在 Python PTC 预设下，用户看到的是「程序是 Python，却标着 typescript」——容易误判成运行时仍在执行 TypeScript。

## 复现

1. 用上游 Python PTC runtime 或任何报告 `language: 'python'` 的 `PtcRuntime` 挂载 `tool-executor-ptc`。
2. 在 Web GUI 里跑一个 `run_code`：`async def` / f-string / 缩进按 Python 生效。
3. 观察工具卡片：语言标签是 `typescript`，正文按 TS 高亮。

## 分析（`0.2.2-rc.1`）

- 执行侧正确：`dsh-tool-executor-ptc/lib/index.js` 的 `RUN_CODE_FLAVORS`/`SDK_RENDERERS` 以 `runtime.language` 为键；`resolveFlavor` 只有 `typescript + function-body` 才用 TS 文案。
- 调用侧缺字段：`presentCall: (args) => ({ card: "generic", title: args.description, kind: "execute", rawInput: args.code })`。
- 类型侧缺字段：`dsh-tools/lib/types/presentation.d.ts` 的 `GenericCallView` 只有 `card/title/kind/rawInput/content/locations`。
- 渲染侧硬编码：`dsh-client-ui-tool/lib/client.js:1806-1815` 的 `code` 分支 `<CodeBlock ... lang: "typescript" />`；前端 `CodeBlock` 头部对已识别的语言直接显示字面量。
- 轨迹视图能显示正确语言，是因为它换了一条路：`dsh-client-ui-trajectory/lib/client.js:4509-4517` 从记录的 tool schema 描述里正则提取 `Execute a program in \`<lang>\``，聊天卡片没有这份 schema 记录，所以拿不到。

## 建议修复（最小改动）

### 1. `@deepseek-ai/dsh-tools`：`GenericCallView` 增加可选语言

```ts
// lib/types/presentation.d.ts, inside GenericCallView
/**
 * Syntax-highlighting language id for the call body when it is source code
 * (e.g. `python`, `typescript`). Omit when the body is not code or the
 * language is unknown; a UI falls back to its own default.
 */
language?: string;
```

### 2. `@deepseek-ai/dsh-tool-executor-ptc`：`presentCall` 带上 runtime language

```js
// lib/index.js
presentCall: (args) => ({
	card: "generic",
	title: args.description,
	kind: "execute",
	rawInput: args.code,
	language: runtime.language,
})
```

（`presentCall` 在工具定义创建时已能访问解析后的 runtime；若定义早于 runtime 解析，闭包内延迟读取即可。）

### 3. `@deepseek-ai/dsh-client-ui-tool`：code 分支使用卡片语言，保留旧默认

```js
// lib/client.js, the `variant === "code" && bodyText !== null` branch
<CodeBlock
	code={bodyText}
	lang={cardView?.language ?? "typescript"}
	...
/>
```

把 `GenericCallView.language` 从行模型（`toolRowModel` 消费的调用呈现信息）透传到该分支；缺省仍为 `typescript`，因此对现有 TypeScript 用户零行为变化。

## 替代方案与取舍

- **在客户端按会话预设猜语言**（本包临时做法）：可立即修复显示，但预设 id 是启发式来源，克隆预设、同一会话混用两种 runtime 时会猜错。
- **复用轨迹视图的正则推断**：依赖 schema 描述的措辞（`Execute a program in \`<lang>\``），schema 文案一改就失效，且聊天卡片没有 schema 记录。
- **让工具在结果里返回语言**：卡片语言在调用开始时就该正确（流式渲染期间），结果期字段太晚。

## 影响面

- 只新增一个可选字段与一个默认值，`ptc`（TypeScript）会话行为不变。
- 修复后，下游按会话预设做客户端覆盖的插件（包括本包）可以直接删除覆盖代码。

## 我们的临时覆盖

本仓库 `dsh-ptc-python-win` 通过 `dsh.client` 注册 keyed `tool.call.toolview` 行，读取会话投影 `agentPreset` 决定语言；上游修复发布后应删除 `lib/client.js`、`package.json` 的 `dsh.client`/`exports["./client"]` 以及 `presets/ptc-python.patch.yml` 的 `ptc-python-client` 行。详见 `docs/gui-language-badge.md`。
