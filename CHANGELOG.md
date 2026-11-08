# Changelog

    ## 0.1.0 — 2026-11-08

    首个公开版本。

    ### 新增

    - `ptc-python` agent preset：把 `run_code` 的语言从 TypeScript 换成 Python，`tools` 命名空间以 `await tools.name({...})` 调用。
    - CPython 运行时 provider（`dsh-ptc-python-win`）：解释器探测、`127.0.0.1` + 随机启动令牌的 TCP 控制通道、逐行 JSON 帧协议、`taskkill /T /F` 进程树清理、墙钟超时与中止。
    - 编译策略：先按普通脚本编译，`SyntaxError` 时回退包裹为 `async def __dsh_main__()`，支持顶层 `await` 与 `return`。
    - 无损 JSON 校验：拒绝超过 2^53−1 的整数、非字符串键、`NaN`/`Infinity`、协程返回值。
    - GUI 适配：`lib/client.js` 接管 `run_code` 卡片，`ptc-python` 会话显示 `python` 标签并按 Python 高亮，其他预设保持 `typescript`。
    - 环境变量裁剪到 Windows 运行必需集合，并强制 `PYTHONUTF8=1`。
    - `test/smoke.mjs`：21 个用例的独立冒烟测试，不依赖 cordis 或 Harness。

    ### 已知限制

    - 仅 Windows（Linux/macOS 请用上游 POSIX provider）。
    - 不提供文件沙箱约束：`sandboxMode` 为 `undefined`，程序文件操作等同当前用户权限。
    - 每次 `run_code` 一个新进程，无 REPL 状态。
    - `workflow-ptc` / `tool-workflow` 依赖 TypeScript 运行时，本预设已禁用。
    