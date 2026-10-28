---
name: delegate-worker
description: "Delegate a bounded, verifiable task to CBC, ZCode, Antigravity CLI (agy) or OpenCode (oc) through the local Herdr agent-bridge, then review, rework in the same session, or accept its delivery. Use for authorized external-agent delegation. Excludes general Herdr pane management."
---

# Herdr 外部执行任务

Codex保留规划、核心决策和最终验收；CBC、ZCode、Antigravity CLI独立执行明确任务。Antigravity对应--agent agy。默认只运行一个外包任务。主控的派工、审查和验收仍消耗Codex配额，执行任务使用各执行端自身账户。

协调器：`{{AGENT_BRIDGE_ROOT}}/bin/agent-bridge.js`。本技能由协调器工程安装，源文件中的路径占位符由安装器绑定到本机检出目录。
默认状态根：`%LOCALAPPDATA%\agent-bridge`；测试或隔离任务设置 `AGENT_BRIDGE_STATE_DIR`。

## 环境与职责

- 官方 `herdr` skill 负责通用终端、Pane 和 Agent 控制。本技能负责委派状态、轮次、交付与验收，不修改或复制官方 skill。
- 一个项目复用一个Workspace。第一标签固定为Codex主Pane占左半屏、执行者占右半屏；第2个执行者只拆右半为上下两格，绝不再拆主Pane。第3个执行者进入新标签；该页依次为整页、左右、右侧上下、四格，满4个再开下一标签。复用现存会话不增加Pane。不搬动或拆分无归属的用户Pane。
- 布局锚点是已核实的Codex主Pane，优先传--pane <主PaneID>；只有Workspace时要求其中有唯一可识别Codex，否则先明确主Pane，不能按UI焦点猜测。独立项目、Worktree或明确隔离时才传--new-workspace --isolation-reason。
- Herdr执行者显示名使用`cbc`、`zcode`等Agent自身名称，有同类存活实例时加简短编号。任务ID与显示名分离；所有任务与会话关联仍以持久状态为准。
- 在 Herdr Pane 中按官方技能读取继承的上下文。若命令经 Codex 常驻 app-server 执行，工具子进程可能没有 `HERDR_*`。此时不得伪造环境标识或依赖焦点；只有用户已指定/授权对应 Herdr 环境时，显式指定已核实的 `--session`，通过协调器执行该任务。
- 通知目标优先使用 `CODEX_THREAD_ID`；实际派工时明确传入 `--codex-thread`。没有可靠目标时先解决绑定，避免产生无人接收的任务。
- 目标目录和任务范围须已在用户授权内。`cwd`、`--add-dir` 和任务说明不是操作系统沙箱，默认 `-y` 会跳过 CBC 常规权限询问。需要权限隔离的任务应使用已配置的沙箱或保留权限检查。

## 派工

派工提示词按以下方法编写。这是Codex的编排职责，不能把一句宽泛目标直接交给执行Agent自行补全。参考[任务规格模板](references/task-brief-template.md)。

1. 明确单一目标、完成后的可观察行为及不做事项。对能力较弱的模型，给出实施顺序和每步产物，避免抽象的“优化一下”“按最佳实践实现”。
2. 写出执行所需的背景、既有实现与参考输入，每个路径说明用途和需要保留的行为；先核对输入确实存在。只传当前任务必要的信息，不复制整段会话。
3. 限定可修改文件、接口和不变条件。明确已有测试是否可改、边界情况、代表性输入输出及错误处理；把适用的用户及项目约定写进规格，例如代码注释中英双语，不能假设执行者继承Codex上下文。未知项不能包装成事实；关键缺口先向主控报告。
4. 逐项给出客观验收命令与预期结果，并写明交付文件、真实证据和停止条件。禁止执行者通过降低期望、隐去失败或自称完成替代验收。
5. 写入task-spec-v1 JSON：goal、background、inputs（path/purpose）、allowedChanges、requirements、acceptance（command/expected）、deliverables必填；steps、preserve、edgeCases、examples、nonGoals、stopConditions按需填写。projectContext只保存可跨任务复用的稳定项目背景。协调器校验必填项，不替Codex猜测需求。

派工前查询`node $bridge sessions --cwd <项目根目录> --agent <执行端>`，参考已保存的目标、文件范围和真实sessionId判断上下文连续性。默认续用相关会话，不要求用户反复说“复用之前会话”。判断由Codex完成，不在工具中建立固定角色或任务类型分类：

- 同一目标、模块或交付的连续实现、调试、补测试，通常沿用同一会话，即使工作阶段或角色称呼改变。
- 角色和任务类型只是线索；无关工作目标、不同且相互冲突的背景、需要独立视角的验证，或用户明确要求多会话时，才另建上下文。不可机械地每次派工、每个阶段都新建。
- 用--worker-key <稳定上下文键>选择已有绑定；默认primary。绑定键只是不透明标识，不是角色枚举，不按任务ID每轮更换。项目cwd保持项目根目录，具体模块通过输入与范围描述。
- 已关闭Pane时根据保存的sessionId重新拉起原生会话，核实身份后继续；不能因为Pane关闭就新开空白会话。连接不确定、占用者变化或原会话仍忙时先恢复/核对，不另开一个规避问题。

同类Agent名称不等于同一会话。首次发送完整规格；核实同一会话后保留背景引用，发送当前目标、变化、参考输入、边界、验收和交付。返工给出失败证据、修复点及应保留内容，不重复解释整个项目。

协调器选择full/delta并保存上下文引用。会话身份变化、压缩、背景或规则版本变化、上下文不确定时退回full。需明确重开时使用--new-session。不得以节省提示词为由省略新要求、差异或验收。

已知上下文被外部修改但身份未变时，使用--full-context要求完整基线。ZCode在重连快照发现压缩或历史窗口不完整时，也会在发送前提升为完整模式。

结构化任务书与规则注入由程序强制执行；自然语言是否选择本技能仍由Codex判断，不能宣称关键词触发率100%。明确说“使用delegate-worker委派给cbc/zcode”可减少歧义。CBC通过原生--append-system-prompt追加稳定规则；ZCode通过V4 sendText注入完整首轮规则和规格，后续为经核实的差量，并不冒充其系统提示词接口。提示词约束不构成操作系统隔离。

```powershell
$bridge = '{{AGENT_BRIDGE_ROOT}}/bin/agent-bridge.js'
node $bridge dispatch --session <已核实的会话名> --workspace <项目WorkspaceID> --codex-thread $env:CODEX_THREAD_ID `
  --cwd <项目根目录> --task-id <任务ID> --worker-key <已有或新建的稳定上下文键> --spec-file <规格JSON路径>
```

首次目录信任仅在该目录已获用户信任/授权时添加 `--trust-folder`。可用 `--model <CBC模型ID> --effort <强度>` 选择执行模型，不修改全局默认。保留 CBC 权限检查时添加 `--no-skip-permissions --permission-mode acceptEdits`。

ZCode使用同一命令加--agent zcode。默认GLM-5.3-Flash、max，复用Desktop登录和Start Plan，连接配置位于状态根zcode-desktop.json，或由--zcode-config指定。先读取[ZCode接入与限制](references/zcode-desktop.md)。不通过浏览器派工，不改安装包，不自动切换模型。默认跳过权限时映射yolo；需保留检查时加--no-skip-permissions --permission-mode edit，出现权限请求后先核实具体命令及已有授权，只能显式单次批准。

Antigravity使用同一命令加--agent agy。先读取[agy执行、权限与恢复](references/agy-cli.md)。使用官方CLI和现有登录，不读取或复制认证值；--model和--effort透传，未指定时继承CLI默认。原生conversation_id是唯一恢复目标，不使用含糊的--continue。CLI会话可跨进程恢复，无需独立后台服务。原生交互界面在Pane中可见；项目级Hook通过官方systemMessage注入稳定规则，同会话同规则版本不重复注入，每轮任务仍给出完整或差量规格。

派工只等待启动和确认任务已开始，不等待任务完成。返回后继续独立工作，或向用户说明后台任务进度并结束当前轮；依靠完成通知继续。不要反复读取未变化的状态和日志。

默认单任务串行。只有用户明确要求并行时才为每个任务传--parallel及独立--worker-key；先划分互不重叠的明确写入文件/目录，公共集成文件由主控处理。工具允许这些明确的并行任务，仍禁止同一上下文同时接收两个未闭合任务。用户举例说明并行不等于要求立即拉起多个Agent。同一ZCode Desktop远控绑定只有一个terminal席位，不能并发占用；CBC可按明确授权并行。

## 通知与验收

通知合并当前待处理任务，并带状态目录。先设置原 `AGENT_BRIDGE_STATE_DIR`，运行 `node $bridge notifications pending --codex-thread $env:CODEX_THREAD_ID`，读取当前 `task.json`，以当前轮次和事件key执行：

```powershell
node $bridge ack <任务ID> --key <通知中的key>
```

通知状态 `queued` 仅表示 Codex 队列已接受，`acknowledged` 才表示主控已确认收到。重复通知按任务/轮次/key去重，不重复验收或返工。

同一状态根与线程最多保留一条协调器提醒；ack、返工、恢复、验收及取消会撤回或更新未执行的旧提醒。需要停止通知时用 `notifications pause`；此操作持久暂停并清理本协调器队列项，不取消CBC。`notifications resume`只唤醒当前未确认任务。服务不可用时检查purgeError，恢复后执行 `notifications reconcile`。这些命令可在普通终端运行，但必须显式设置原状态根和 `--codex-thread <原线程ID>`。

- `review_pending`：报告存在，尚未验收。检查真实改动并运行任务书的验收命令。
- `delivery_missing`：结束但未交报告。检查一次现场后决定返工。
- `blocked`：需要输入或权限，启动阶段也可能发生。主动读取当前Pane的visible提示，不能等待用户提醒；核对路径与动作，在已有授权内处理，缺少授权时交给用户。对原生CLI可发送明确按键或文本，优先单次批准；不无条件回车或授予永久权限。
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

`rework`追加新要求；`resume`处理failed/blocked，必要时按已保存的执行会话ID重建Pane；`recover`对账、重启watcher或补发已明确失败的通知。ZCode普通resume重连权威快照、观察原commandId，重建Pane不重发原指令。自动重投任务可能重复产生副作用，恢复前先核对交付和终端。

返工改变正式要求或验收时同时传 `--spec-file <更新后的规格JSON>`；只补充已定位缺陷时使用简洁的--prompt-file差量。任务完结后保留执行会话台账，后续同项目任务优先尝试复用已验收且身份一致的执行者。只有实际绑定相同会话才能按已有上下文精简提示。

重建执行 Pane 时仍复用原项目 Workspace，不自动新建 Workspace。`resume --force` 会明确重投已保存任务，只能在已检查现场、确认可以重试后使用；普通 `recover` 不因连接错误自动重发任务。

通知为 `uncertain` 时，可能已经入队。先核对是否已收到；只有确认需要重新投递时使用 `recover <任务ID> --resend-notification`。外部队列与本地文件没有跨进程事务，不宣称严格 exactly-once。

断网或配额恢复后先read检查原会话。普通resume只恢复存活Pane的监听；需要发送继续指令时使用具体rework要求。Codex自身不可用时交付仍落盘，恢复后检查pending再验收；不以无限模型轮询代替恢复流程。通知RPC失败保留pending，响应不确定保留uncertain，不降级为旧的不可撤回投递。协调器不管理CBC CLI自身内部重试。

人工接管时只操作 task.json 中记录的 Herdr 会话和 Pane，并检查当前占用者。不要在协调器仍判定 `running` 时另发相同任务。需要停止时执行 `cancel` 并确认状态。

OpenCode昵称oc，面板同名；使用同一派工命令加--agent oc，原--agent opencode兼容，先读[OpenCode V2执行与审批](references/opencode-cli.md)。保留原生TUI，通过官方CLI API提交和核对真实会话；稳定规则用持久会话指令注入。模型继承原生配置，effort按模型variant目录验证。审批优先官方API单次批准，恢复不重放原任务。

## 扩展边界

`agent-bridge agents` 查询已注册执行者。目前为CBC、ZCode、agy、opencode；不同执行端的能力与限制见对应参考文件。后续Agent须验证启动、真实会话恢复、状态事件和取消后再投入派工，注册名称本身不证明可用。
