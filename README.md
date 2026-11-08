# dsh-ptc-python-win

[![npm version](https://img.shields.io/npm/v/dsh-ptc-python-win)](https://www.npmjs.com/package/dsh-ptc-python-win)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/yukitakasama/dsh-ptc-python-win/actions/workflows/ci.yml/badge.svg)](https://github.com/yukitakasama/dsh-ptc-python-win/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)

让 DeepSeek Harness 的 **PTC（programmatic tool calling）模式**用 Python 写程序，而不是 TypeScript。

> A CPython implementation of the DeepSeek Harness PTC runtime for Windows: `run_code` programs are Python, and every tool is called as `await tools.name({...})`.

会话选中 `ptc-python` 预设后，模型只有一个工具 `run_code`；它写出的 Python 程序里通过 `await tools.xxx({...})` 调用其他工具，程序在**全新的 CPython 子进程**里执行，`print` 与 `return` 的结果回到对话。

```python
import asyncio

files = await tools.glob({"pattern": "**/*.py"})
results = await asyncio.gather(*[
    tools.read({"file_path": path})
    for path in files["paths"][:5]
])
print(f"read {len(results)} files")
return {"count": len(results)}
```

## 为什么不是一个普通的 npm 插件

上游确实发布过 `@deepseek-ai/dsh-experimental-ptc-runtime-python`，但它的实现绑定 POSIX：

- 控制通道走子进程 **fd 3**（Windows 上非 libuv 子进程拿不到 fd 3）；
- 清理用 `kill(-pgid)` 进程组信号；
- 加载期直接拒绝非 Unix 平台（`README.zh.md`：「执行限于本地 Unix 宿主」）。

本包是同一套 `PtcRuntime` 契约的 Windows 实现：控制通道改用 **127.0.0.1 上的临时 TCP 连接 + 随机启动令牌**，清理用 `taskkill /T /F`，其余语义（每调用一个新进程、`tools` 绑定命名空间、`ToolCallError`、JSON 无损输出）与上游一致。

它不 import 任何 `@deepseek-ai/*` 模块，只用 Node 内置模块，并按照 `Service` 内部同样的方式 `ctx.reflect.provide('ptcRuntime', runtime)` 注册自己，因此在 profile 的 pnpm 布局里不会出现 peer 依赖解析问题。

## 安装

需要：Windows、Node ≥ 20、`python` 在 PATH 上且为 CPython ≥ 3.10、Harness 0.2.2-rc.1。

```powershell
$profile = "$env:USERPROFILE\.dsh-packs\<profile 名>\profiles\<profile 名>"

# 从 npm 安装（--no-save 避免 npm 改写 profile 自己的依赖声明）
npm install --prefix $profile --no-save dsh-ptc-python-win

# 或者：从源码链接（开发用，目录联接即可，不需要 pnpm/npm）
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-ptc-python-win" `
  -Target "<本仓库路径>"
```

然后在该 profile 的 `package.json` 里把包登记为 bundle —— `dsh.profile.bundles` 追加 `"dsh-ptc-python-win"`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "……", "dsh-ptc-python-win"]
    }
  }
}
```

**重启 Harness**（preset 在启动时注册），在 Web 的 General 设置里把 agent preset 选成 `ptc-python`，或新建会话时选择该预设。

卸载：从 `bundles` 里删掉这一项、删除 `node_modules` 里的包（或 junction）、重启。

## 验证挂载

`--dump-config` 只组合配置、不挂载插件；确认真实挂载用启动追踪（`DSH_PTC_PY_DEBUG` 指向一个文件，插件 `apply()` 成功时追加一行）：

```powershell
$env:DSH_HOME = "$env:USERPROFILE\.dsh-packs\<profile 名>"
$env:DSH_PTC_PY_DEBUG = "$env:TEMP\ptc-py-mount-trace.txt"
dsh --profile <profile 名> --port 0 --no-open
# 启动后：
Get-Content "$env:TEMP\ptc-py-mount-trace.txt"
# 2026-11-08T05:20:51.436Z ptc-python mounted pythonBin=python pid=3820
```

这一行只有在预设定义被注册、`isolate: {ptcRuntime: true}` 作用域建立、`ctx.reflect.provide('ptcRuntime', …)` 成功之后才会写出——若与 host 面的 TypeScript 运行时抢占同名服务，这里会先抛错。

## 语义

- **程序形态**：优先把程序当普通脚本编译（多行字符串、缩进原样保留）；只有在出现 `SyntaxError` 时才回退包裹进 `async def __dsh_main__()`，从而支持顶层 `await` 和 `return`。两者都失败时报模块级语法错误（行号真实）。
- **工具调用**：`await tools.name({...})`，也接受关键字参数 `await tools.name(a=1)`。参数必须是可无损 JSON 化的值；超过 2^53−1 的整数、非字符串键、`NaN/Infinity` 会被拒绝。
- **返回值**：`print` 的输出是日志，`return` 的值是结果；两者都必须是可无损 JSON 化的值。返回协程会得到明确提示（「await 它」）。
- **进程隔离**：每次 `run_code` 一个新进程，变量/模块不跨调用保留；工作目录为会话工作目录；环境变量被裁剪到 Windows 运行所需的最小集合，并强制 UTF-8。
- **超时**：墙钟从程序交给 Python 开始计时（不含解释器启动），超时后 `taskkill /T` 杀掉整棵进程树。
- **错误**：`run()` 从不因程序失败而 reject，失败放在结果的 `error` 字段里：`exception`、`invalid-output`、`output-limit`、`timeout`、`abort`、`worker-exit`、`protocol`。

## 配置

插件 config（见 `presets/ptc-python.patch.yml` 的 `ptc-runtime-python` 行）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `pythonBin` | Windows `python`，其他 `python3` | 解释器命令或绝对路径；首次运行时探测版本并缓存 |
| `defaultTimeoutMs` | `120000` | 未指定 `timeoutMs` 时的墙钟上限 |
| `maxTimeoutMs` | `600000` | `run_code` 允许指定的上限 |
| `maxLogBytes` | `65536` | stdout/stderr 截断阈值 |
| `maxValueBytes` | `32768` | 返回值大小上限（超出为 `output-limit`） |
| `maxCallValueBytes` | `4194304` | 单次工具返回值上限 |

## GUI 语言标签（run_code 卡片）

Web GUI 里 `run_code` 卡片的语言标签**不来自运行时**。核心包 `@deepseek-ai/dsh-client-ui-tool` 渲染 code 变体时写死了 `lang: "typescript"`（本机 `0.2.2-rc.1` 的 `lib/client.js:1810`），executor 的 `presentCall` 也只带 `title`/`kind`/`rawInput`，没有语言字段。所以在 `ptc-python` 会话里程序确实是 Python，卡片却仍显示 `typescript`、并按 TS 高亮。

本包因此在 `lib/client.js` 里注册了一个 keyed `run_code` 行接管该卡片：读取会话投影 `agentPreset`，命中 `ptc-python`（`PYTHON_PRESETS`）时用 `python` 渲染代码块和标签，其他预设保持 `typescript`（内置 `ptc` 预设是 TS，不会被改）。这是客户端覆盖，执行侧逻辑不受影响。

接线在 `presets/ptc-python.patch.yml` 末尾的 `ptc-python-client` 行：app 级 entry 直接是裸包名 `dsh-ptc-python-win`，再由 `package.json` 的 `dsh.client` 把 `lib/client.js` 组合进前端。该行带 `config.clientAnchor: true`，`lib/index.js` 的 `apply()` 见到它就立即返回，只当发现锚点、不注册 `ptcRuntime`（真正的 provider 由预设内的 `ptc-runtime-python` 行注册；app 根部已有 TypeScript 的 `ptc-runtime`，在这里注册会报 `service "ptcRuntime" has been registered`）。这里必须用裸包名，不能用子路径（如过去的 `dsh-ptc-python-win/client-host`）：`dsh-client-modules` 的 `exactPackageSpecifier()` 对含 `/` 的名字返回 `undefined`，`locatePkgJson()` 随后直接放弃，子路径行永远不会被扫到。

注意：

- 需要**重启 Harness**：客户端 bundle 在启动期组合，刷新页面不会加载新 bundle。
- 复制的预设 id 不在 `PYTHON_PRESETS` 里时仍显示 `typescript`；按需改 `lib/client.js` 顶部的数组。
- 本覆盖锚定 DSH `0.2.2-rc.1` 的客户端槽位 API。上游若把语言放进卡片元数据，应优先改用上游能力（见 `docs/upstream-issue.md`），随后可删除前端覆盖。
- 根因、验证步骤与回滚见 `docs/gui-language-badge.md`。

## 已知限制

- **不做文件沙箱约束**：本 provider 报告 `sandboxMode === undefined`，所以 `run_code` 没有 `sandbox_permissions` 参数，程序里的 Python 文件操作**不受** DSH 文件沙箱限制，等同于当前用户权限。需要约束时请使用 TypeScript 运行时。
- **workflow 不可用**：`workflow-ptc` / `tool-workflow` 需要 TypeScript 运行时，本预设已把它们禁用（与上游 Python provider 的要求一致）。
- **仅 Web 的 preset 机制**：预设挂在会话作用域。TUI 是单会话、进程级组合，要用 Python PTC 需把 host 面的 `ptc-runtime` 行改成本包（`lib/index.js` 的 `apply` 对两种挂载方式都适用）。
- **每个调用一个新进程**：没有 REPL 持久状态，跨调用复用昂贵计算需要写文件或走工具。
- **GUI 覆盖绑定核心版本**：`lib/client.js` 依赖 `0.2.2-rc.1` 的客户端槽位（keyed `tool.call.toolview` 行、`CodeBlock`/`TextShimmer` 原语）。核心客户端重构后覆盖可能失效；失效时卡片回退到核心行（显示 `typescript`），不影响 Python 执行。

## 开发

```powershell
node test/smoke.mjs   # 21 个用例：绑定、并发、错误、超时、编码、伪造帧等
```

冒烟测试直接驱动 `createPythonRuntime()`，不需要 cordis 上下文或 Harness。注意它需要以管道 stdio 启动 Python 子进程；在 DSH 的受限沙箱下 `spawn` 会以 `EPERM` 失败（21 个用例全挂在 `worker-exit`），需要在非受限环境运行。CI（`.github/workflows/ci.yml`）在 `windows-latest` 上跑 Node 20/22 × Python 3.10/3.12 四组矩阵，是这条测试的标准运行环境。

## 目录结构

```
.
├── lib/index.js                  # provider：解释器探测、TCP 控制通道、帧协议、超时/中止/清理、apply() 注册
├── lib/client.js                 # 浏览器半：按会话预设渲染 run_code 卡片（python/typescript）
├── py/bootstrap.py               # 子进程侧：编译策略、tools 绑定、无损 JSON 校验、traceback 整形
├── presets/ptc-python.patch.yml  # 预设声明（ptc 预设 + 私有 Python 运行时组 + GUI 行）
├── test/smoke.mjs                # 21 个用例的独立冒烟测试
├── .github/workflows/ci.yml      # CI：windows-latest + Node/Python 矩阵，跑 check + 冒烟测试
├── docs/gui-language-badge.md    # GUI 语言标签问题的根因、接线、验证与回滚
├── docs/upstream-issue.md        # 上游修复建议与最小 patch
├── package.json                  # dsh.bundle.patch / dsh.client 指向预设与客户端 bundle
├── CHANGELOG.md                  # 版本记录
├── LICENSE
└── README.md
```

## 许可证

MIT。

