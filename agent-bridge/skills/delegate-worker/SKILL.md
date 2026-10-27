---
name: delegate-worker
description: "Delegate a bounded, verifiable task to an external worker through the local Herdr agent-bridge, then review, rework in the same session, or accept its delivery. Use for explicit CBC delegation or substantial separable work when external delegation is authorized. Excludes general Herdr pane management, which belongs to the official herdr skill."
---

# Herdr 外部执行任务

Codex 保留规划、核心决策和最终验收；CBC 独立执行明确任务。默认只运行一个外包任务。主控的派工、审查和验收仍消耗 Codex 配额，执行任务使用 CBC 自身账户；两边额度不按同一账户推定共享。

协调器：`{{AGENT_BRIDGE_ROOT}}/bin/agent-bridge.js`。本技能由协调器工程安装，源文件中的路径占位符由安装器绑定到本机检出目录。
默认状态根：`%LOCALAPPDATA%\agent-bridge`；测试或隔离任务设置 `AGENT_BRIDGE_STATE_DIR`。

## 环境与职责

- 官方 `herdr` skill 负责通用终端、Pane 和 Agent 控制。本技能负责委派状态、轮次、交付与验收，不修改或复制官方 skill。
- 一个项目复用一个 Workspace。有调用 Pane 时默认创建同级 Pane；只有已核实的 Workspace 时，在其中创建 Tab。工具未继承上下文时传 `--workspace <ID>` 或 `--pane <ID>`，不使用 UI 焦点推断。独立项目、Worktree或明确隔离时才传 `--new-workspace --isolation-reason <原因>`。
- Herdr 执行 Agent 显示名为 `cbc`，有同类存活实例时加简短编号。任务ID与显示名分离；所有任务与会话关联仍以持久状态为准。
- 在 Herdr Pane 中按官方技能读取继承的上下文。若命令经 Codex 常驻 app-server 执行，工具子进程可能没有 `HERDR_*`。此时不得伪造环境标识或依赖焦点；只有用户已指定/授权对应 Herdr 环境时，显式指定已核实的 `--session`，通过协调器执行该任务。
- 通知目标优先使用 `CODEX_THREAD_ID`；实际派工时明确传入 `--codex-thread`。没有可靠目标时先解决绑定，避免产生无人接收的任务。
- 目标目录和任务范围须已在用户授权内。`cwd`、`--add-dir` 和任务说明不是操作系统沙箱，默认 `-y` 会跳过 CBC 常规权限询问。需要权限隔离的任务应使用已配置的沙箱或保留权限检查。

## 派工

将自包含任务写到文件，参考 [任务书模板](references/task-brief-template.md)。包含允许修改的文件、已有实现、可执行验收命令、预期结果及协调器指定的报告位置。避免复制整段历史对话。

```powershell
$bridge = '{{AGENT_BRIDGE_ROOT}}/bin/agent-bridge.js'
node $bridge dispatch --session <已核实的会话名> --workspace <项目WorkspaceID> --codex-thread $env:CODEX_THREAD_ID `
  --cwd <任务目录> --task-id <任务ID> --prompt-file <任务书路径>
```

首次目录信任仅在该目录已获用户信任/授权时添加 `--trust-folder`。可用 `--model <CBC模型ID> --effort <强度>` 选择执行模型，不修改全局默认。保留 CBC 权限检查时添加 `--no-skip-permissions --permission-mode acceptEdits`。

派工只等待启动和确认任务已开始，不等待任务完成。返回后继续独立工作，或向用户说明后台任务进度并结束当前轮；依靠完成通知继续。不要反复读取未变化的状态和日志。

## 通知与验收

通知合并当前待处理任务，并带状态目录。先设置原 `AGENT_BRIDGE_STATE_DIR`，运行 `node $bridge notifications pending --codex-thread $env:CODEX_THREAD_ID`，读取当前 `task.json`，以当前轮次和事件key执行：

```powershell
node $bridge ack <任务ID> --key <通知中的key>
```

通知状态 `queued` 仅表示 Codex 队列已接受，`acknowledged` 才表示主控已确认收到。重复通知按任务/轮次/key去重，不重复验收或返工。

同一状态根与线程最多保留一条协调器提醒；ack、返工、恢复、验收及取消会撤回或更新未执行的旧提醒。需要停止通知时用 `notifications pause`；此操作持久暂停并清理本协调器队列项，不取消CBC。`notifications resume`只唤醒当前未确认任务。服务不可用时检查purgeError，恢复后执行 `notifications reconcile`。这些命令可在普通终端运行，但必须显式设置原状态根和 `--codex-thread <原线程ID>`。

- `review_pending`：报告存在，尚未验收。检查真实改动并运行任务书的验收命令。
- `delivery_missing`：结束但未交报告。检查一次现场后决定返工。
- `blocked`：需要输入或权限。读取具体提示，在已有授权内处理；缺少授权时交给用户。
- 网络、限流、配额耗尽或等待超时也可进入 `blocked`。保存会话与轮次，不自动换模型、新建会话或反复重派。默认监听上限30分钟，可用派工参数 `--wait-timeout-ms` 调整；超时不代表原CBC已停止。
- `failed`：查看错误，确认 worker 是否还在执行，再决定恢复。
- `submission_unknown`：提交结果不确定，禁止直接重发。`recover` 只对账；无活动证据时人工确认。
- `cancel_pending`：中断尚未确认，不能当作已停止。
- `accepted` / `cancelled`：验收通过 / 已确认取消。

验收须检查文件范围和真实输出，报告中的“完成”不作为通过依据。通过后 `accept` 并继续原开发计划；不通过时写明具体缺陷和验收命令，在原任务上 `rework`。

```powershell
node $bridge rework <任务ID> --prompt-file <返工要求>
node $bridge accept <任务ID>
```

## 恢复与接管

```powershell
node $bridge status <任务ID>
node $bridge read <任务ID>
node $bridge recover <任务ID> --codex-thread $env:CODEX_THREAD_ID
node $bridge resume <任务ID>
node $bridge cancel <任务ID>
```

`rework` 追加新要求；`resume` 处理 failed/blocked，必要时按已保存的执行会话ID重建 Pane；`recover` 对账、重启 watcher 或补发已明确失败的通知。自动重投任务可能重复产生副作用，恢复前先核对交付和终端。

重建执行 Pane 时仍复用原项目 Workspace，不自动新建 Workspace。`resume --force` 会明确重投已保存任务，只能在已检查现场、确认可以重试后使用；普通 `recover` 不因连接错误自动重发任务。

通知为 `uncertain` 时，可能已经入队。先核对是否已收到；只有确认需要重新投递时使用 `recover <任务ID> --resend-notification`。外部队列与本地文件没有跨进程事务，不宣称严格 exactly-once。

断网或配额恢复后先read检查原会话。普通resume只恢复存活Pane的监听；需要发送继续指令时使用具体rework要求。Codex自身不可用时交付仍落盘，恢复后检查pending再验收；不以无限模型轮询代替恢复流程。通知RPC失败保留pending，响应不确定保留uncertain，不降级为旧的不可撤回投递。协调器不管理CBC CLI自身内部重试。

人工接管时只操作 task.json 中记录的 Herdr 会话和 Pane，并检查当前占用者。不要在协调器仍判定 `running` 时另发相同任务。需要停止时执行 `cancel` 并确认状态。

## 扩展边界

`agent-bridge agents` 查询已注册执行者。目前仅 CBC 已实现；后续 Agent 必须完成启动、会话恢复、状态事件和取消适配后才可投入派工。注册表中的名称不等于接入已经可用。ZCode 调查和适配由工程说明管理，不在技能中提前加入未验证命令。
