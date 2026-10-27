# Codex Agent Bridge

以Codex为主控，通过Herdr管理外部执行Agent。Codex负责规划、核心开发、派工、独立审查和最终验收；CBC与ZCode执行明确、可验证的子任务，后续按统一契约接入其他Agent。

当前版本：0.3.1。CBC要求Node.js 20及以上；ZCode执行端使用Node.js 24及以上、已登录并启用远控的ZCode Desktop。运行环境保持原生Windows、PowerShell与Herdr。公开源码不包含认证配置或本机原始会话。

GitHub仓库：[RichardYeoh/codex-agent-bridge](https://github.com/RichardYeoh/codex-agent-bridge)。验证工作流使用Windows运行器，执行自动回归和交付验收。

## 安装

在工程根目录执行：

```powershell
npm ci
npm test
npm run test:e2e
npm run install:skills
```

已有Herdr、Codex及CBC可用时，安装技能即可让Codex发现delegate-worker。首次安装或修复CBC事件集成时，再运行：

```powershell
npm run install:integration
```

安装器只维护本工程的CBC Hook和delegate-worker，不覆盖官方Herdr技能，不改Codex全局配置。技能从工程源文件安装，并自动绑定当前检出位置；配置修改后须重启相关CBC会话。安装备份位于agent-bridge/backups，禁止上传。

## 日常使用

1. 在Herdr中打开实际项目的Workspace，启动或恢复Codex。
2. 用自然语言要求Codex将明确工作交给CBC，说明允许修改的范围和验收要求。例如：“把这个数据转换脚本交给CBC实现，由你检查真实改动并运行验收，通过后继续原计划。”
3. Codex使用delegate-worker编写结构化任务书，在当前Workspace的Pane或Tab运行指定执行者。默认单任务；明确隔离或独立Worktree时才新建Workspace。
4. 交付只进入review_pending，由Codex独立验收；不通过时原会话rework，通过后accept并继续主计划。

派工不会等待整个任务完成。事件监听和队列操作由程序执行，避免模型反复轮询。双方仍分别消耗自身账户额度；任务范围与独立验收由Codex负责。

任务规格包含目标、背景、参考输入、允许修改范围、实施约束、客观验收和交付物。新派工必须提供--spec-file，缺项在启动前报错。Codex先查询sessions台账，根据工作上下文连续性选择已有worker-key，用户不必反复强调复用。角色和任务类型只是判断线索，工具不预设分类。Pane关闭后也优先按保存的sessionId恢复原会话；身份核实后可继续差量派工。--new-session用于明确重开。

主标签固定由Codex占左半屏，右侧最多上下两个执行Pane；第3个执行者进入新标签，该页按整页、左右、右侧上下、四格扩展，满4个再加标签。会话复用不新增Pane。只有用户明确要求并行时才传--parallel与不同worker-key，且写入范围不得重叠。[完整规则与验证](docs/上下文复用与面板布局.md)。

ZCode使用Desktop Host的原生Remote Relay/RPC，日常不需要浏览器操作技能，不需要另外提供DeepSeek或Z.ai API key。默认GLM-5.3-Flash、low；繁忙或断网时保留会话，不自动换模型。首次绑定、权限选项、人工接管及技术边界见[ZCode接入说明](docs/ZCode接入与方案选择.md)。

## 状态、暂停与恢复

默认任务状态在本机的 `%LOCALAPPDATA%/agent-bridge`，也可通过AGENT_BRIDGE_STATE_DIR指定。未完成任务必须保留原状态根和执行Agent原生会话数据。

```powershell
$bridge = Join-Path $PWD 'agent-bridge/bin/agent-bridge.js'
node $bridge list
node $bridge status <任务ID>
node $bridge read <任务ID>
node $bridge recover <任务ID> --codex-thread $env:CODEX_THREAD_ID
node $bridge notifications pending --codex-thread $env:CODEX_THREAD_ID
node $bridge notifications pause --codex-thread $env:CODEX_THREAD_ID
node $bridge notifications resume --codex-thread $env:CODEX_THREAD_ID
```

普通终端中CODEX_THREAD_ID可能未设置，此时传原线程ID。暂停通知不取消执行；停止任务使用cancel并确认结果。断网、限流、配额耗尽及等待超时保留会话与轮次，不自动重派。监听默认30分钟，可在派工时配置；超时不表示worker已经停止。普通resume在存活Pane上恢复监听，需要继续指令时在原会话rework。

同一状态根与Codex线程合并保留一条提醒，确认、返工、恢复、验收或取消会撤回失效项。通知服务不可用时本地pending，入队响应不确定时uncertain，恢复后对账。已进入执行的消息无法撤回。完整参数见[协调器说明](agent-bridge/README.md)。

## 持续维护与扩展

后续维护从[AGENTS.md](AGENTS.md)、[进度台账](协作环境进度台账.md)顶部开始；需要历史依据时读取[项目会话记录](项目会话记录.md)。新会话可直接使用：

> 继续维护当前检出的codex-agent-bridge。先读取AGENTS.md、README.md和协作环境进度台账.md顶部，按需读取审核报告和项目会话记录。Codex为唯一主控，保留多执行Agent扩展。本次需要改进：……

处理未完成任务时补充任务ID和原状态根。更换Codex线程时先暂停旧线程提醒，再显式recover绑定新线程，不重新派发同一任务。技能修改从agent-bridge/skills/delegate-worker开始，再运行install:skills。

[执行Agent适配契约](agent-bridge/docs/adapter-contract.md)保留启动、状态、追加要求、结果、取消和会话恢复语义。ZCode已通过Desktop Start Plan真实文本、文件任务、同会话返工、Pane恢复、增量上下文及取消测试；接口来自官方内部实现，已固定源码版本，Desktop升级需复验。

## 交付与证据

| 位置 | 内容 |
|---|---|
| agent-bridge | 协调器、CBC适配描述、Hook、安装器、委派Skill及自动测试 |
| evidence/2026-10-27 | 公开的测试工程、回归结果、原生队列实验结果及ZCode实验记录 |
| tools | 显式运行的队列和ZCode最小实验，默认输出到.local |
| Codex审核报告.md | 架构、修复、端到端证据、资源控制与ZCode路线比较 |
| 协作环境进度台账.md、项目会话记录.md | 当前状态、后续工作和有价值的过程记录 |
| .local | 本机完整迁移归档、运行状态与安装备份等，不进入Git |

当前公开历史记录已去除本机账户路径和运行会话标识，原始记录在迁移机器的.local归档中。克隆GitHub仓库可获得继续开发所需源码、文档和测试；恢复本机旧任务还需要本地状态及Agent原生会话存储。

当前验证结果见[evidence/2026-10-27-integration](evidence/2026-10-27-integration/README.md)，原8项交付验收保留。新版通知的空闲自动唤醒仍需真实补验；整机重启、所有权限分支和长期无人值守未全面验证。Codex实验性队列接口在0.164.0验证，升级后需复验。

仓库公开可见，当前未授予开源许可证；是否添加许可证另行确定。
