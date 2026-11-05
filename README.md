# Codex Agent Bridge

以Codex为主控，通过Herdr管理外部执行Agent。Codex负责规划、核心开发、派工、独立审查和最终验收；CBC、ZCode、Antigravity CLI（agy）与OpenCode执行明确、可验证的子任务，后续按统一契约接入其他Agent。

当前CBC分层协议版本：0.6.0（发布ID `cbc-v2-0.6.0-r3`）；旧任务与其他执行端保留0.5.0兼容路径。CBC要求Node.js 20及以上；ZCode执行端使用Node.js 24及以上、已登录并启用远控的ZCode Desktop。运行环境保持原生Windows、PowerShell与Herdr。公开源码不包含认证配置或本机原始会话。

CBC的新派工通过原入口自动选择V2，固定请求回执、交付快照和独立验收；交付后的普通聊天不回退旧结果。Herdr显示由已安装`herdr-codebuddy`插件负责。已有任务不热迁移，详情见[分层发布与验证](docs/CBC分层协议发布与验证.md)及其使用说明。

CBC 2.179.2的DeepSeek 1M窗口已通过显式载入[窗口预设](agent-bridge/examples/cbc-context-1m.json)的真实TUI及短请求验证。2026-11-03检查发现本机cbc三个入口的参数注入已失效，普通cbc不保证1M；本轮整改已让桥接buildCommand显式传入该预设，新启动不再依赖入口注入。此变更经命令构造回归，未重启现有CBC或重做真实百万token压力验证。安装、检查、恢复及npm升级边界见[CBC窗口验证说明](docs/CBC上下文窗口设置与验证.md)；新机器不会因克隆仓库自动改动全局入口。

GitHub仓库：[RichardYeoh/codex-agent-bridge](https://github.com/RichardYeoh/codex-agent-bridge)。验证工作流在Windows执行完整回归和交付验收，另设Ubuntu纯逻辑与进程锁检查；新增CI任务尚未远端运行，不能代替Windows原生执行端实测。

发布前运行`npm run check:publication`检查已跟踪及未忽略的新文件，暂存后运行`node tools/check-publication.cjs --staged`检查实际提交内容。本机状态、认证配置、原生会话身份、依赖、归档及临时输出不得入库；`.local`中的证据仅在维护机器保留。普通CBC入口与ZCode恢复的真实环境限制随源码保留，不以隔离回归替代业务恢复证明。

CBC首次启动前失败且未创建原生会话时，使用[启动前失败恢复流程](docs/CBC启动前失败恢复.md)，经证据核对取消旧派工申请，再按原绑定首次dispatch；无需恢复不存在的会话ID。

本次Hark整改与复审范围见[47项整改表](hark_yotta_review/整改结果.md)，正式恢复入口见[异常恢复与资源隔离](docs/异常恢复与资源隔离.md)。已提交任务不因resume/force重投；明确未发送与当前原生空闲分别举证。

ZCode原生已完成但本地提交未知时，使用[原生命令对账](docs/ZCode不确定提交与原生命令对账.md)。恢复区分同代投影与跨代历史证明，最多进入review_pending，不重放正文；真实业务接续仍由原主控执行。

CBC专项维护采用精确原生输入与Stop证明，修复回执丢失后的自动只读对账、旧idle快照误结算及进程读取短暂失败。实机与模拟验证分别记录于[CBC专项复审说明](hark_yotta_review/CBC专项复审说明.md)。[社区与官方接口调查](docs/Herdr社区与CBC接口评估.md)尚未发现可直接替代当前交互与验收流程的完整方案，未安装或迁移到其他平台。

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
4. 交付只进入review_pending，由Codex独立验收；不通过时原会话rework，通过后accept，核对会话ID已登记且执行已收敛，再关闭该执行Pane并继续主计划。会话历史保留，相关任务以后按原ID重新拉起。

派工不会等待整个任务完成。事件监听和队列操作由程序执行，避免模型反复轮询。双方仍分别消耗自身账户额度；任务范围与独立验收由Codex负责。

任务规格包含目标、背景、参考输入、允许修改范围、实施约束、客观验收和交付物。新派工必须提供--spec-file，缺项在启动前报错。Codex先查询sessions台账，根据工作上下文连续性选择已有worker-key，用户不必反复强调复用。角色和任务类型只是判断线索，工具不预设分类。Pane关闭后也优先按保存的sessionId恢复原会话；身份核实后可继续差量派工。--new-session用于明确重开。

主标签固定由Codex占左半屏，右侧最多上下两个执行Pane；第3个执行者进入新标签，该页按整页、左右、右侧上下、四格扩展，满4个再加标签。用途标题由Codex在派工时设置，例如“oc · JPEG仿真验证”；注册名和会话身份独立保留。仍存活的Pane可复用，已关闭时按原会话ID重新创建运行Pane。只有用户明确要求并行时才传--parallel与不同worker-key，且写入范围不得重叠。[完整规则与验证](docs/上下文复用与面板布局.md)。

用途命名和验收后关闭由Codex/Skill执行，当前accept命令本身只记账，不自动退出；无需修改各工具的原生会话名称或退出接口。用户明确要求保留窗口时可保留，身份或后台执行状态不确定时先保留现场。

ZCode使用Desktop Host的原生Remote Relay/RPC，日常不需要浏览器操作技能，不需要另外提供DeepSeek或Z.ai API key。默认GLM-5.3-Flash、max；繁忙或断网时保留会话，不自动换模型。首次绑定、权限选项、人工接管及技术边界见[ZCode接入说明](docs/ZCode接入与方案选择.md)。

Antigravity使用官方agy原生交互界面，与CBC一样在Herdr Pane中显示对话和审批。按实际conversation_id恢复，首次为项目合并本机Hook绑定，PreInvocation注入稳定系统规则。自然语言可直接要求“把这项工作交给agy，由你验收”；启动、权限、人工接管与验证范围见[Antigravity接入说明](docs/Antigravity接入与验证.md)。

OpenCode昵称oc，可直接说“交给oc”或使用--agent oc；原opencode名称兼容，面板显示oc。OpenCode使用V2官方API派工并保留原生TUI，按真实sessionID恢复。默认沿用OpenCode自身模型配置，显式variant须核对模型目录；审批可通过CLI逐项读取和单次批准。见[OpenCode接入说明](docs/OpenCode接入与验证.md)。

oc外包交付明显低质，或同一任务连续两次交付未达要求时，由Codex在原会话切换为GLM-5.3完整版并继续返工；全局默认保留。该质量升级规则由Codex验收触发，网络、配额和审批问题不计入质量失败。

## 状态、暂停与恢复

CBC已取消任务可通过dispatch --resume-task <旧任务ID>严格沿用原生会话，不需要伪造accepted。ZCode cancel_pending且Pane缺失时，recover可只读核对原命令与空闲状态后确认取消；原生不确定、活动或审批仍保持阻塞。具体步骤见[CBC终态会话接续与取消核对](docs/CBC终态会话接续与取消核对.md)。

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

普通终端中CODEX_THREAD_ID可能未设置，此时传原线程ID。暂停通知不取消执行；停止任务使用cancel并确认结果。断网、限流、配额耗尽及等待超时保留会话与轮次，不自动重派。其他执行端监听默认30分钟，可在派工时配置；超时不表示worker已经停止。ZCode将该时长作为可自动续订的观察窗口，按原命令权威终态收口。普通resume在存活Pane上恢复监听，需要新指令时使用rework；已经人工提交的ZCode命令不得再次rework重投，应按[长任务观察与命令接管](docs/ZCode长任务观察与人工命令接管.md)核对后adopt。

同一状态根与Codex线程合并保留一条提醒，确认、返工、恢复、验收或取消会撤回失效项。通知服务不可用时本地pending，入队响应不确定时uncertain，恢复后对账。已进入执行的消息无法撤回。完整参数见[协调器说明](agent-bridge/README.md)。

OC的旧任务若停在cancel_pending，可在原状态根执行recover再读取status。恢复仅核验原生会话：确认无活跃工作、审批和表单后收口cancelled，Pane已关闭也可处理；不重发中断或任务，不重建会话。仍活跃或API证据不足时保留阻塞，详见[OC状态与恢复](docs/OpenCode接入与验证.md#状态与恢复)。

OC新任务在round 0、尚未提交时，不再因原生会话上一轮failed而直接阻塞。普通resume核验身份、租约及原生空闲后提交原任务书；本轮失败仍单独上报。主控和共享OC服务无需重启，已运行的旧Pane观察器需由业务主控在核实空闲和归属后关闭，再普通resume按原ID重新附着，详见[历史失败与新任务准入](docs/OpenCode接入与验证.md#历史失败与新任务准入)。

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


## Codex到YDot的事件通知增量（接入已取消）

用户已取消本次接入。官方Tunnel客户端、安装包、启动绑定及采集配置/状态已移入.local/archives/YDOT-BRIDGE-CLEANUP-20261031-C1；约91.98 MiB可恢复保留，未永久删除。父项目三项观察Hook已精确移除，用户通过/hooks处理后，官方原会话运行清单确认0项；底层信任记录未清理。旧启动入口因活动绑定缺失而失败关闭，不自动查找归档。

事件桥接源码、测试、文档及历史校验/验收证据保留；既有Agent派工与队列RPC不变，不新增远程shell或审批工具。清理仅做两项精确回滚回归，2/2通过，归档摘要逐项一致，未重跑无关全量。详细结果、恢复清单和自然Stop后续观察边界见[操作清单第9节](docs/YDot安全接入操作清单.md#9-c1取消接入与可恢复清理)。旧安装和密钥输入说明为历史方案，不能继续执行。

## Hark审核整改恢复入口

已提交轮次的resume（包括force）不会重投任务；OC明确失败可显式resume --retry-failed，迟到交付使用settle，原生会话移动或服务恢复后使用adopt-restored。未知终态可保留资源隔离地abandon，不能假称cancelled。命令和证据要求见[异常恢复与资源隔离](docs/异常恢复与资源隔离.md)，全部审核条目和验证结果见[整改结果](hark_yotta_review/整改结果.md)。
