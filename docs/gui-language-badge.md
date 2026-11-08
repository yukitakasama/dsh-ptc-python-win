# GUI 语言标签：为什么 Python PTC 会话显示 `typescript`

> 适用版本：DSH `0.2.2-rc.1`（`<DSH 安装目录>\versions\0.2.2-rc.1`）。
> 本文记录问题根因、本包采取的客户端覆盖、验证步骤与回滚方式。

## 症状

`ptc-python` 预设的会话里，`run_code` 程序确实按 Python 执行（语法高亮可能是 TS 风格，但程序里的 `async def`、f-string、缩进都按 Python 生效），然而 Web GUI 的工具卡片：

- 头部语言标签显示字面量 `typescript`；
- 展开后的程序正文按 TypeScript 语法高亮。

## 执行侧确认（Python 是真的）

- 模型侧工具 schema 只有 `run_code`，描述是 `Execute a Python program ...`；会话日志 `request/header` 可查。
- `@deepseek-ai/dsh-tool-executor-ptc` 的 `RUN_CODE_FLAVORS = { typescript, python }` 与 `SDK_RENDERERS = { typescript: renderToolsSdk, python: renderToolsSdkPy }` 都按 `runtime.language` 路由；本包 provider 报告 `language: 'python'`。
- 因此「看起来是 TypeScript」与执行无关，是渲染问题。

## 根因（渲染侧硬编码）

1. `@deepseek-ai/dsh-client-ui-tool` 的客户端 bundle 里，`run_code` 被归类为 `code` 变体（`TOOL_VARIANTS.run_code = "code"`），渲染分支写死语言：

   ```js
   // dsh-client-ui-tool/lib/client.js:1806-1815 (0.2.2-rc.1)
   variant === "code" && bodyText !== null
     ? <CodeBlock code={bodyText} lang: "typescript" ... />
   ```

2. executor 的卡片元数据也不带语言：

   ```js
   // dsh-tool-executor-ptc/lib/index.js
   presentCall: (args) => ({ card: "generic", title: args.description, kind: "execute", rawInput: args.code })
   ```

   `GenericCallView`（`@deepseek-ai/dsh-tools/lib/types/presentation.d.ts:47-69`）的字段只有 `card/title/kind/rawInput/content/locations`，没有语言字段。

3. 前端 `CodeBlock` 头部（`dsh-web-frontend/dist/assets/index-*.js`）直接显示已识别的语言字面量：`children: Ly(e) ? e : i.codeLabel`，语言字典里 `typescript`/`ts`/`tsx`/`js` 都归一为 `typescript`，`py`/`python` 归一为 `python`。所以 `lang: "typescript"` 必然显示 `typescript`。

4. 轨迹视图（trajectory）另有自己的兜底：`dsh-client-ui-trajectory/lib/client.js:4509-4517` 的 `recordedLanguage(schemaRaw)` 从记录的 tool schema 描述里正则提取 `Execute a program in \`<lang>\``，再用参数描述里的 `TypeScript`/`Python` 兜底。聊天卡片没有这份 `schemaDetail`，所以没走这条路径。

## 修复选择

| 方案 | 结论 |
| --- | --- |
| 改 DSH 安装目录里的核心文件 | 拒绝：升级即丢，且不属于本仓库 |
| provider 端注入语言 | 无法单独完成：卡片元数据类型由 `dsh-tools` 定义，新增字段需改核心类型与客户端消费端 |
| 客户端覆盖（本包采用） | 核心扩展点：keyed `tool.call.toolview` 命中会替换通用行；浏览器 bundle 由 `dsh.client` 清单组合 |

客户端覆盖的代价：`lib/client.js` 复制了核心 code 行的状态/摘要/输出推导（`toolRowModel` 语义），并绑定 `0.2.2-rc.1` 的客户端槽位 API。核心升级后若失效，卡片会回退到核心行（显示 `typescript`），Python 执行不受影响；上游修复落地后应删除本覆盖（见 `docs/upstream-issue.md`）。

## 实现要点（`lib/client.js`）

- 以 `window.__ModuleLoader__.load({ id: "dsh-ptc-python-win", factory })` 形式提供浏览器 bundle（无构建步骤），`exports.apply`/`exports.inject = ["slots"]`。
- `apply` 里 `ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({ name: "tool.call.toolview", key: "run_code", locale: "conversation" }, RunCodeRow))`。`inject` 会等核心注册的槽位可用，因此模块加载顺序无关。
- 语言来源：会话投影 `agentPreset`（`useSessions((state) => state.byId[sessionId]?.projectionValues?.agentPreset)`）。`programLanguage()` 命中 `PYTHON_PRESETS`（默认 `["ptc-python"]`）返回 `python`，否则 `typescript`——内置 `ptc` 预设就是 TypeScript，不能被误标。
- 行模型照抄核心：`done = "kind" in block`；`argsRaw` 取 `block.call.argsRaw`（已结束）或 `block.argsRaw`（流式 `start`）；state 分 `preparing/running/stopped/error/ok`；摘要取参数 `description` 首行；正文取参数 `code`（非字符串时 pretty JSON）；输出拼接结果 content 文本，空内容且有 error 时用 `name: code`。
- 复用前端注入的原语：`CodeBlock`（`lang` 按会话决定，`toolbarLabels` 必传，否则 Core 内部会解引用 `labels.unwrapLabel` 报错）、`TextShimmer`、`IconCodeOutlineRegular`、`IconChevronUpOutlineRegular`/`IconChevronDownOutlineRegular`。
- 行样式自注入 `style[data-plugin-css="dsh-ptc-python-win/run-code.module.css"]`，类名前缀 `ptc-rc-`，颜色变量与核心 bash 行一致。

## 接线

- `package.json`
  - `exports["./client"] = "./lib/client.js"`（`dsh-client-modules` 通过 `clientExportOf` 读取）；
  - `dsh.client = { platform: "web", inject: [ui-tool, ui-conversation, client-locale] }`。`platform` 必须是 `web`，否则 `parseDshClient` 返回 null 被静默忽略；`inject` 只是模块图排序边，未知包名会被忽略。
- `presets/ptc-python.patch.yml` 根级 `insert:` 列表新增 app 级行，直接指向本包：

  ```yaml
  - id: ptc-python-client
    name: dsh-ptc-python-win
    config:
      clientAnchor: true
  ```

  为什么这样接：

  - **必须是 app 级 entry**：`dsh-client-modules` 只遍历 `ctx.loader.entries()`（app 级 Loader 树），而 agent preset 的插件行挂在 `dsh-agent-preset-registry` 的 `PresetTree` 里，不在那棵树中，所以客户端 bundle 只能由 app 级 entry 带出来。
  - **必须是裸包名**：`exactPackageSpecifier()` 对任何含 `/` 的名字返回 `undefined`，`locatePkgJson()` 遇到「非路径名且 specifier 为 undefined」直接 `return void 0`。因此 `dsh-ptc-python-win/client-host` 这类子路径行**永远不可能**被发现——包进不了 app 级 Loader 图，`dsh.client` 也就不会被组合进前端。
  - **`clientAnchor` 让 `apply()` 只当锚点**：app 根部已有 `ptc-runtime`（TypeScript 实现）提供 `ptcRuntime`，这个 app 级 entry 若直接挂本包，`apply()` 的 `ctx.reflect.provide("ptcRuntime", …)` 会抛 `service "ptcRuntime" has been registered`。`apply()` 对 `config.clientAnchor === true` 立即返回，不注册任何服务；真正的 provider 由上面预设组（`isolate: { ptcRuntime: true }`）里的 `ptc-runtime-python` 行注册。

## 验证

1. `node --check lib/client.js`（语法；bundle 里没有 Node API，纯静态检查足够）。
2. 重启 Harness（客户端组合发生在启动期；只刷新页面不会加载新 bundle）。
3. 打开一个 `ptc-python` 会话，DevTools 里确认模块图包含 `dsh-ptc-python-win`（`window.__ModuleLoader__` 已加载条目），控制台无插件报错。
4. 跑一次 `run_code`：卡片头部与展开代码块的语言标签应为 `python`。
5. 打开内置 `ptc` 预设的会话跑一次 `run_code`：仍应为 `typescript`（确认没有误伤）。
6. 回归：用 `node test/smoke.mjs` 确认运行时/协议未变（非受限环境执行）。

## 回滚

1. 删除 `presets/ptc-python.patch.yml` 末尾的 `ptc-python-client` 行。
2. 删除 `package.json` 的 `dsh.client` 与 `exports["./client"]`。
3. 删除 `lib/client.js`（或保留文件但不再接线）。
4. 重启 Harness。卡片回到核心行，语言标签恢复硬编码的 `typescript`，Python 执行不受影响。
