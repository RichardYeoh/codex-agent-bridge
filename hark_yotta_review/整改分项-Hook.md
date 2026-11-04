# Hark 审核整改分项：Herdr Hooks 与恢复命令

主控集成补记：AGY最终保留Herdr内置agy类型，custom:agent-bridge-agy作为来源；临时agent-bridge-agy类型只作为旧身份兼容，不能以自报标签取得原生控制。下文若含改专属标签的早期结论，以本说明及总报告为准。

日期：2026-11-04
范围：Hark 审核报告 CM-06、CM-08、CM-13 中的 Hook 子项。仅修改 `agent-bridge/hooks/*`、新增 `agent-bridge/bin/resume-worker.js`、`agent-bridge/test/hark-hook-resume.test.js`，更新 AGY 既有测试 fixture 与本分项；未修改公共 CLI、`agents.js`、`worker-context.js` 或真实执行端。

## 分项结论

| 编号 | 结论 | 证据与边界 |
|---|---|---|
| CM-06 | **代码路径已修复；Herdr 实机恢复未验证** | CBC 与 AGY Hook 的 `report-agent` 将恢复命令首词固定为 PATH 命令 `node`，后续调用新增 `resume-worker.js`。该包装器按显式 stateDir、taskId、native session ID读取任务并核验绑定，再调用 agent descriptor 的 `buildCommand`，保留已登记的模型、effort、权限模式、settings、任务目录及系统策略，并向子进程传递核实后的 stateDir/taskId/Herdr session。启动前要求继承的 Pane ID 与已认领 task Pane 一致，实际 `pane get` 与 `pane list`/`agent list` 对当前 Pane/terminal 一致；只读全量 inventory 不得显示其他 Pane 持有相同 native ID 或旧 terminal。Pane 已移动但 task/lease 尚未认领时拒绝启动并提示 `adopt-restored`。首次 CBC Hook 可在 task 和 lease 的 native ID 均为空时，基于精确 task/pane/terminal/workerStartedAt/round 与实际 terminal 查询绑定首个原生 ID。手册约束检查覆盖首词、单引号、控制字符、64 参数及8 KiB。命令参数不安全时仅省略 `-- resume_argv`，当前状态仍上报。测试通过 dry-run、fake Herdr inventory 和注入的 PowerShell spawn 替身；未启动真实 Herdr、CBC 或 AGY，也未测试 Herdr 服务重启后的实际恢复。 |
| CM-08 | **Hook 侧独立证据已加固；主控启动流程不在本切片** | AGY Hook 只将实际 `conversationId` 与 task、Pane、Herdr session、terminal lease 和 Herdr `pane get` 返回的当前 terminal 精确匹配后的记录标为 `agy-native-hook`，并写入 round、terminal ID。lease 缺失、当前 Pane/terminal 查询失败或身份字段不匹配时均 fail closed：不注入 policy/message、不写状态纠正或 native attestation，也不报告恢复命令。preflight 记录和已知 task/native ID 均不能替代租约及 live terminal 证明。隔离测试分别验证完整绑定可注入、缺少 lease、live terminal 缺失及不匹配时无 policy 或状态副作用。现有 `worker-context.js` 已按 `agy-native-hook` 与 terminal ID 筛选，本轮未修改该文件。 |
| CM-13 | **Hook 子项已修复；非 Hook 杂项由主控处理** | 删除 CBC Hook 中重复的非 `permission_prompt` Notification 判断；AGY `--agent` 标签设为 `agent-bridge-agy`，与 Herdr 内置 kind 区分。CBC 保留已由 `agents.js` 注册的 `codebuddy` 标签和 `custom:agent-bridge` source，避免改变运行时身份契约。主控已同步 AGY descriptor 并保留旧 `agy` 兼容标签。CM-13 报告中的 Codex list 游标与 AGY 配置忽略项不属于本切片。 |

## 实现接口

Hook 生成的 Herdr 恢复参数为：

```text
node <checkout>/agent-bridge/bin/resume-worker.js <stateDir> <taskId> <nativeSessionId>
```

`hooks/herdr-resume.js` 集中校验 resume argv。首词只允许纯命令名；所有参数必须为字符串且不得含 ASCII 单引号或控制字符；总计不超过64项、合并后 UTF-8 长度不超过8 KiB。stateDir 转为绝对路径后仍须通过全部校验。任何条件不满足时返回 `null`，Hook 保留 `report-agent` 状态参数并省略 `--` 及恢复参数。

`bin/resume-worker.js` 只接受三个位置参数。它校验 taskId 格式、stateDir 与 task 文件绑定、native session ID 一致、工作目录存在；`accepted`、`cancelled`、`abandoned` 状态拒绝启动。有效任务交由 `getAgent(task.agent).buildCommand(task, nativeId)` 构建原生启动命令，再通过 PowerShell 7 命令行启动并继承 Pane 的标准输入输出；同时将核实后的 stateDir、taskId、Herdr session 写入子进程环境，供 Hook 继续绑定状态根和租约。测试通过依赖注入替身核对命令、环境和参数，没有调用实际执行端。

## 验证记录

官方手册 `.local/hark-remediation-20261104/herdr-official.txt` 的 “Report the resume command” 明确规定：首词必须是 PATH 上的 plain command name；任一参数不得含单引号或控制字符；最多64参数、总长8 KiB；违规时 Herdr 返回 `invalid_resume_argv` 且整条状态报告不生效。因此实现将恢复命令放在 `node` 后，并在附加前完整校验。

执行命令：

```text
node --check hooks/herdr-agy.js
node --check hooks/herdr-codebuddy.js
node --test test/hark-hook-resume.test.js test/agy-hooks.test.js
```

结果：20项通过、0失败、0跳过。用例覆盖安全/不安全 argv、CBC 任务轮次/原生 session/terminal 绑定、首次空 native-ID lease 经 Herdr 实际 Pane terminal 查询后绑定、bridge lease 无法核验时停止上报、通知去重、AGY preflight 与 native Hook 证据区分、缺少 lease/live Pane terminal 及 terminal 不匹配时不注入、不写状态、不产生 native attestation、恢复任务拒绝终态、恢复前全量 native owner/旧 terminal 冲突拒绝，以及 CBC/AGY descriptor 参数保留。所有 Hook 均使用临时状态目录、`AGENT_BRIDGE_HOOK_DRY_RUN`、fake Herdr inventory 和 PowerShell spawn 替身；没有连接真实服务或启动真实 agent。
