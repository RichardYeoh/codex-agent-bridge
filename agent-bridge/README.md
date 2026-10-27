# 协调器操作说明 0.2.2

项目定位、安装、维护与发布见[根目录README](../README.md)。在项目根目录运行npm ci；全部依赖由根package-lock.json锁定。

## 派工和验收

```powershell
$bridge = Join-Path $PWD 'agent-bridge/bin/agent-bridge.js'
node $bridge dispatch --session default --workspace <已核实的项目WorkspaceID> `
  --cwd <业务项目目录> --task-id <任务ID> --codex-thread $env:CODEX_THREAD_ID --prompt-file <任务书>
node $bridge status <任务ID>
node $bridge read <任务ID>
node $bridge ack <任务ID> --key <当前事件key>
node $bridge rework <任务ID> --prompt-file <返工要求>
node $bridge accept <任务ID>
```

也可用--pane指定调用Pane，创建同级Pane。明确隔离才用--new-workspace --isolation-reason。执行显示名cbc，任务ID独立；已有同类执行者时显示名加短编号。

目录信任已获授权时可添加--trust-folder。CBC默认-y；需要保留权限检查时传--no-skip-permissions --permission-mode acceptEdits。可传--model和--effort，不修改全局默认。cwd与--add-dir不是操作系统沙箱。

主控先notifications pending获取当前任务/轮次/key，再ack并独立验收。报告存在仅进入review_pending，不通过时原会话rework，通过后accept。异步派工返回后继续独立工作，或结束本轮等待完成提醒，不反复查询未变化状态。

## 恢复与通知

```powershell
node $bridge recover <任务ID> --codex-thread <目标Codex线程ID>
node $bridge resume <任务ID>
node $bridge cancel <任务ID>
node $bridge notifications pause --codex-thread <线程ID>
node $bridge notifications status --codex-thread <线程ID>
node $bridge notifications pending --codex-thread <线程ID>
node $bridge notifications resume --codex-thread <线程ID>
node $bridge notifications reconcile --codex-thread <线程ID>
```

命令均须使用原AGENT_BRIDGE_STATE_DIR；普通终端显式传线程ID。recover对账、恢复死亡watcher及处理明确失败通知，不因连接错误自动重发。resume在存活Pane上恢复监听；需要继续要求时rework。确认原执行状态且可以重试后才使用resume --force；原Workspace丢失时可额外指定--workspace或--pane。

网络、限流、额度错误和等待超时保留原会话/轮次，进入blocked。默认监听1800000毫秒，派工--wait-timeout-ms或AGENT_BRIDGE_WAIT_TIMEOUT_MS可调整，0为显式无限等待。超时不表示原执行停止，不杀worker、不自动重派；协调器不控制CBC自身内部网络重试。

queued只表示入队，acknowledged表示主控确认。Codex 0.164.0原生thread/queue CRUD合并同状态根/线程提醒并撤回失效项，只清理本协调器消息。pause先持久保存开关再清理队列，不取消CBC；清理失败返回purgeError，恢复后reconcile。通知服务不可用保留pending，响应不确定为uncertain。明确确认需要补发时recover --resend-notification。不保证跨队列/文件严格exactly-once；已开始执行的提醒无法撤回。

## 配置与实现入口

| 环境变量 | 含义 |
|---|---|
| AGENT_BRIDGE_STATE_DIR | 状态根，默认本机LOCALAPPDATA下agent-bridge |
| HERDR_BIN_PATH、HERDR_SESSION | Herdr入口及命名服务，显式session参数优先 |
| AGENT_BRIDGE_CBC | CBC入口 |
| AGENT_BRIDGE_CODEX_JS | Codex JS入口，用于连接本机app-server proxy |
| AGENT_BRIDGE_PERMISSION_MODE | 非跳过模式的默认权限模式 |
| AGENT_BRIDGE_WAIT_TIMEOUT_MS | 新任务每轮监听上限，派工参数优先 |

Agent描述在lib/agents.js，位置在lib/location.js，身份与会话在lib/worker.js，通知在lib/notify.js、lib/notification-control.js、lib/codex-client.js，错误分类在lib/blocker.js。唯一第三方运行依赖为ws@8.22.0。

技能更新先改skills/delegate-worker，再从根目录npm run install:skills；只有需要写CBC Hook配置时才install:integration，安装前会备份，不覆盖官方Herdr技能。

扩展新Agent见[适配契约](docs/adapter-contract.md)。审核范围见[报告](../Codex审核报告.md)，迁移与归属见[维护说明](../docs/迁移与维护.md)。
