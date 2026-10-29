# 协调器操作说明 0.5.0

项目定位、安装、维护与发布见[根目录README](../README.md)。在项目根目录运行npm ci；全部依赖由根package-lock.json锁定。

## 派工和验收

```powershell
$bridge = Join-Path $PWD 'agent-bridge/bin/agent-bridge.js'
node $bridge dispatch --session default --workspace <已核实的项目WorkspaceID> `
  --cwd <业务项目目录> --task-id <任务ID> --codex-thread $env:CODEX_THREAD_ID --spec-file <任务规格JSON>
node $bridge sessions --cwd <业务项目目录> --agent cbc
node $bridge status <任务ID>
node $bridge read <任务ID>
node $bridge ack <任务ID> --key <当前事件key>
node $bridge rework <任务ID> --prompt-file <返工要求>
node $bridge accept <任务ID>
```

优先--pane指定Codex主Pane，协调器固定保留其左半屏和完整高度，先填右侧上下两个执行Pane，后续按每标签4格扩展。只有Workspace时要求有唯一Codex锚点。明确隔离才用--new-workspace --isolation-reason。执行显示名cbc、zcode、agy或opencode，任务ID独立；已有同类执行者时显示名加短编号。默认CBC，加--agent zcode选择Desktop执行端。

规格写法见[模板](skills/delegate-worker/references/task-brief-template.md)。goal、background、inputs、allowedChanges、requirements、acceptance和deliverables必填，按需补steps、preserve、examples、edgeCases、nonGoals、stopConditions。projectContext保存稳定项目背景。Codex根据上下文连续性选择--worker-key，默认primary；该键不定义固定角色。相关会话默认复用，已关闭Pane也按保存sessionId恢复，核实后使用差量。--new-session明确重开，--full-context明确发送完整背景。正式需求变更时rework同时传--spec-file。

默认串行。只有用户明确要求并行时，各任务均传--parallel及独立--worker-key，且allowedChanges必须为互不重叠的明确文件/目录，不接受含糊glob。同一绑定的未闭合任务不能被新任务挤占。ZCode同一Desktop Relay绑定仍需串行。具体选择规则和布局顺序见[说明](../docs/上下文复用与面板布局.md)。

目录信任已获授权时可添加--trust-folder。CBC默认-y；需要保留权限检查时传--no-skip-permissions --permission-mode acceptEdits。可传--model和--effort，不修改全局默认。cwd与--add-dir不是操作系统沙箱。

主控先notifications pending获取当前任务/轮次/key，再ack并独立验收。报告存在仅进入review_pending，不通过时原会话rework，通过后accept。异步派工返回后继续独立工作，或结束本轮等待完成提醒，不反复查询未变化状态。

oc支持rework --model <provider/model>，可同时指定目标模型支持的--effort；模型变更在原workerSessionId执行并保存请求历史，不新建会话，不改全局默认。未指定effort时清除旧模型的variant绑定。其他执行端的rework暂不支持这些参数，须使用其原生恢复流程。质量明显偏低或同一任务连续两次交付验收失败时，Codex按delegate-worker的oc规则升级到GLM-5.3完整版；网络/额度阻塞不计为质量失败。

Codex派工后把Pane标题设置为“注册名 · 用途”，用途短名写入该任务状态目录worker-label.txt；恢复出新Pane时重新应用，不在协调器之外改Agent注册名。验收后由Codex确认会话登记、Pane归属及后台执行已收敛，再关闭本任务执行Pane。accept命令本身不自动关闭；会话历史与ID保留，相关任务以后按原ID重新拉起。详细流程见delegate-worker和[上下文说明](../docs/上下文复用与面板布局.md)。

agy使用原生交互CLI，加--agent agy选择。支持--model、--effort，未指定时继承CLI配置；--no-skip-permissions --permission-mode accept-edits保留原生审批，已授权目录才传--trust-folder。首次派工自动合并项目.agents/hooks.json并生成本机入口脚本，保留其他Hook；这些绑定不应提交到业务仓库。启动预检仅核验conversation_id，不发送模型任务。详见[接入说明](../docs/Antigravity接入与验证.md)。

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

命令均须使用原AGENT_BRIDGE_STATE_DIR；普通终端显式传线程ID。recover对账、恢复死亡watcher及处理明确失败通知，不因连接错误自动重发。resume恢复监听；ZCode还重连权威快照，并在重建Pane时观察原commandId，不自动重发原任务。需要继续要求时rework。确认原执行状态且可以重试后才使用resume --force；原Workspace丢失时可额外指定--workspace或--pane。

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
| AGENT_BRIDGE_ZCODE_CONFIG | ZCode私有连接JSON路径，派工--zcode-config优先 |

Agent描述在lib/agents.js，位置在lib/location.js，身份与会话在lib/worker.js，规则/规格在lib/worker-policy.js，上下文回执在lib/worker-context.js，Pane任务租约在lib/worker-lease.js。ZCode传输与会话观察在lib/zcode-remote.js，终端适配器在bin/zcode-worker.js，单次权限接管在bin/zcode-control.js。通知与验收继续复用公共实现。安装依赖为ws@8.22.0，另有固定版本的ZCode协议子集与zod置于vendor/zcode，许可证及重建方法随文件提供。

ZCode默认Flash/max，跳过权限时为yolo；需权限检查时--no-skip-permissions --permission-mode edit。Start Plan要求Desktop已登录并开启官方远控，连接JSON默认位于状态根zcode-desktop.json。具体配置和路线比较见[接入说明](../docs/ZCode接入与方案选择.md)。

技能更新先改skills/delegate-worker，再从根目录npm run install:skills；只有需要写CBC Hook配置时才install:integration，安装前会备份，不覆盖官方Herdr技能。

扩展新Agent见[适配契约](docs/adapter-contract.md)。审核范围见[报告](../Codex审核报告.md)，迁移与归属见[维护说明](../docs/迁移与维护.md)。
