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
- 一个项目复用一个Workspace。第一标签固定为Codex主Pane占左半屏、执行者占右半屏；第2个执行者只拆右半为上下两格，绝不再拆主Pane。第3个执行者进入新标签；该页依次为整页、左右、右侧上下、四格，满4个再开下一标签。复用存活Pane不增加位置，已关闭则按原会话ID重建。不搬动或拆分无归属的用户Pane。
- 布局锚点是已核实的Codex主Pane，优先传--pane <主PaneID>；只有Workspace时要求其中有唯一可识别Codex，否则先明确主Pane，不能按UI焦点猜测。独立项目、Worktree或明确隔离时才传--new-workspace --isolation-reason。
- Herdr注册名保留协调器生成的`cbc`、`oc-2`等唯一名称；Codex把Pane可读标题改为“注册名 · 用途短名”，例如“oc · JPEG仿真验证”。用途由Codex按本轮任务或持续职责判断，不设置固定角色分类，不用改名替换会话身份。
- 在 Herdr Pane 中按官方技能读取继承的上下文。若命令经 Codex 常驻 app-server 执行，工具子进程可能没有 `HERDR_*`。此时不得伪造环境标识或依赖焦点；只有用户已指定/授权对应 Herdr 环境时，显式指定已核实的 `--session`，通过协调器执行该任务。
- 通知目标优先使用 `CODEX_THREAD_ID`；实际派工时明确传入 `--codex-thread`。没有可靠目标时先解决绑定，避免产生无人接收的任务。
- 目标目录和任务范围须已在用户授权内。`cwd`、`--add-dir` 和任务说明不是操作系统沙箱，默认 `-y` 会跳过 CBC 常规权限询问。需要权限隔离的任务应使用已配置的沙箱或保留权限检查。

## 主控工具权限与启动预检

按实际能力需求选择已获授权的权限配置：只读审查、限定目录实现/仿真、需要调度外部执行者的主控分别考虑，不能按模型名称或父子关系推定权限。职责范围、操作系统沙箱和执行Agent自身审批是三层约束；创建者能访问Herdr不代表新Codex线程能访问。独立验证主控即使只允许写验证目录，也可能需要单独获准访问Herdr和Codex消息IPC。

首次派工前由实际调用者在自己的工具上下文做只读预检，核实Herdr服务/Pane、目标消息路由及本轮实际权限；主控代测成功不能替代。权限不足时停止该控制路径、保留准确错误，使用已有授权代理或请求用户选择适当配置；不自动改沙箱、Windows ACL、共享服务或全局权限，不把完整访问设为所有执行者的默认值。

会创建其他Codex线程的上级主控也应在交接中明确这些要求；本技能本身不提供Codex建会话或授权接口。已运行会话收到新要求后直接读取本节及[工具权限与预检](references/executor-permissions.md)，不为加载规则重启owner。Skill只能指导决策，不能授予平台权限或保证自动触发。

## 派工

派工时先确定一个可识别的用途短名。dispatch成功返回后，由Codex使用返回的herdrSession/paneId执行pane rename，标题包含Agent注册名和用途；不要直接改agent注册名，否则会与task.json中的身份核对不一致。若启动阻塞但已创建Pane，读取落盘任务并核对归属后，也可先按执行端短名与用途标注，不为命名重派任务。不要求执行工具支持原生会话重命名。

把用途短名以UTF-8写入该任务状态目录的worker-label.txt（与worker-policy.md同目录），不手工修改task.json或把真实sessionId写入公开文档。复用已有绑定时先读取sessions候选的lastTaskId所对应worker-label.txt，连续工作默认保留用途；缺少标签时根据已登记目标/范围判断。Pane关闭后重新拉起、返工或恢复导致新Pane时，由Codex重新设置可读标题。同一会话用途调整不改变worker-key或sessionId。

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

默认同项目单任务串行，独立项目仍须保证原生会话、Relay和写入范围不冲突。只有用户明确要求并行时才为每个任务传--parallel及独立--worker-key；先划分互不重叠的明确写入文件/目录，公共集成文件由主控处理。工具允许这些明确的并行任务，仍禁止同一上下文同时接收两个未闭合任务。用户举例说明并行不等于要求立即拉起多个Agent。同一ZCode Desktop远控绑定只有一个terminal席位，不能并发占用；CBC可按明确授权并行。

## 通知与验收

对`taskProtocol: 2`的CBC任务，先读`status`中的`layers`和`read`返回的冻结报告。`transport.admitted`才表示精确原生输入已接纳；`review.pending`才表示结构化交付与原生Stop齐全；技术通过仍由主控决定。Herdr的idle/done或插件侧栏不替代任务回执。`observation.unavailable`不等于执行失败，使用`recover <taskId>`只恢复对账，不重发。

V2验收对象为不可变产物快照。若`sourceDrift`非空，应审查冻结版本与当前文件的差异，不把当前工作区误当本轮产物；交付后的未封装聊天不回退已完成请求。运行中外来输入须保护归属，不能冒领其Stop。`bridge-result`由工具注入并绑定请求，执行者不得accept。原生会话关闭后保留ID，已完成任务可冷恢复；在途V2请求不直接改Pane绑定。

版本路由自动区分新CBC、已有V2及旧任务，不需手填协议字段。混合版本recover须指定taskId。操作与回滚见发布版本`docs/layered-v2/05-使用与维护.md`。

通知合并当前待处理任务，并带状态目录。先设置原 `AGENT_BRIDGE_STATE_DIR`，运行 `node $bridge notifications pending --codex-thread $env:CODEX_THREAD_ID`，读取当前 `task.json`，以当前轮次和事件key执行：

```powershell
node $bridge ack <任务ID> --key <通知中的key>
```

通知状态 `queued` 仅表示 Codex 队列已接受，`consumed`仅表示已离队，`acknowledged` 才表示主控已确认收到。无ack经冷却和持久化预算可有限提醒，不能把离队当验收。重复通知按任务/轮次/key去重，不重复验收或返工。

同一状态根与线程最多保留一条协调器提醒；ack、返工、恢复、验收及取消会撤回或更新未执行的旧提醒。需要停止通知时用 `notifications pause`；此操作持久暂停并清理本协调器队列项，不取消CBC。`notifications resume`只唤醒当前未确认任务。服务不可用时检查purgeError，恢复后执行 `notifications reconcile`。这些命令可在普通终端运行，但必须显式设置原状态根和 `--codex-thread <原线程ID>`。

- `review_pending`：报告存在，尚未验收。检查真实改动并运行任务书的验收命令。
- `delivery_missing`：结束但未交报告。检查一次现场后决定返工。
- `blocked`：需要输入或权限，启动阶段也可能发生。主动读取当前Pane的visible提示，不能等待用户提醒；核对路径与动作，在已有授权内处理，缺少授权时交给用户。对原生CLI可发送明确按键或文本，优先单次批准；不无条件回车或授予永久权限。
- 网络、限流、配额耗尽或等待超时也可进入 `blocked`。保存会话与轮次，不自动换模型、新建会话或反复重派。默认监听上限30分钟，可用派工参数 `--wait-timeout-ms` 调整；超时不代表原CBC已停止。
- `failed`：查看错误，确认 worker 是否还在执行，再决定恢复。
- `submission_unknown`：提交结果不确定，禁止直接重发。`recover` 只对账；无活动证据时人工确认。
- CBC新轮次使用精确原生输入/Stop证明。`text_queued`不能称“已接纳”；只有task中的原生接纳回执才能这样报告。丢失ACK或发送者崩溃时先观察/对账，不用force重放；人工后续输入使旧轮归属失效，不能凭同task/round Hook继续验收旧工作。具体恢复与限制读取工程`docs/CBC精确回合与恢复.md`。Stop后存在报告只到review_pending，不代表技术通过。旧Hook没有路径时用显式`--cbc-transcript`核对；不猜原生文件。
- `cancel_pending`：中断尚未确认，不能当作已停止。
- `accepted` / `cancelled`：验收通过 / 已确认取消。

验收须检查文件范围和真实输出，报告中的“完成”不作为通过依据。通过后 `accept` 并继续原开发计划；不通过时写明具体缺陷和验收命令，在原任务上 `rework`。

```powershell
node $bridge rework <任务ID> --prompt-file <返工要求>
node $bridge accept <任务ID>
```

accept成功后默认由Codex关闭该执行Pane、结束本次终端运行，再继续主计划。协调器accept本身仍只记账和清理注册名，不自动关闭；不能把调用accept当作退出步骤已经完成。用户明确要求保留窗口时按其要求执行。

关闭前重新读取accepted任务与sessions台账，确认真实workerSessionId、交付和上下文回执已保存；核对当前Herdr服务、Pane、terminal、Agent类型和最新Pane租约仍属于此任务，且不是Codex主Pane、用户窗口或已被后续任务接管的Pane。只在执行已收敛、无待处理审批/后台工作且idle/done时，调用该服务的pane close。运行或身份不确定时保留现场并说明未关闭原因；不为清理窗口取消其他工作。Pane已经关闭则跳过，不创建新Pane来关闭。

“结束会话”指结束本次执行运行和关闭Pane，保留原生会话历史、worker-key、workerSessionId、用途记录、任务状态和交付，供相关任务按原ID重新拉起。不要删除原生会话、退出账号、停止共享后台服务或关闭整个Workspace。ZCode完成后连接已释放时直接关闭桥接Pane，不要求关闭Desktop中的历史会话。

## 恢复与接管

```powershell
node $bridge status <任务ID>
node $bridge read <任务ID>
node $bridge recover <任务ID> --codex-thread $env:CODEX_THREAD_ID
node $bridge resume <任务ID>
node $bridge cancel <任务ID>
```

`rework`追加新要求；`resume`处理failed/blocked，必要时按已保存的执行会话ID重建Pane；`recover`对账、重启watcher或补发已明确失败的通知。ZCode普通resume重连权威快照、观察原commandId，重建Pane不重发原指令。自动重投任务可能重复产生副作用，恢复前先核对交付和终端。

ZCode观察窗口自动续订；尾窗没有turnHeader时，匹配的activeWorks只证明原命令仍在执行，结束须以同session/command的权威历史核实。原生正常结束且指定交付存在才进入review_pending；缺报告为delivery_missing，禁止凭文件存在或agent idle单独判断完成。观察器持有Relay时禁止额外snapshot探针争抢席位。用户已在原session人工提交后，不得再rework同份任务；先核对原始envelope、接纳回执、当前原生命令与旧轮终态，再用adopt-zcode登记下一轮，仅附着观察。用法见{{AGENT_BRIDGE_ROOT}}/../docs/ZCode长任务观察与人工命令接管.md。旧轮完成通知不授权关闭正在执行新命令的Pane。

返工改变正式要求或验收时同时传 `--spec-file <更新后的规格JSON>`；只补充已定位缺陷时使用简洁的--prompt-file差量。任务完结后保留执行会话台账，后续相关任务默认按登记ID重新拉起已验收会话，而不是长期保留空闲Pane；若用户要求保留的执行者仍存活，则核对身份后直接复用。只有实际绑定相同会话才能按已有上下文精简提示。

重建执行 Pane 时仍复用原项目 Workspace，不自动新建 Workspace。`resume --force`不能重投已提交轮次或绕过不确定准入；位置和监听恢复须符合[正式恢复边界](references/recovery-safety.md)。普通 `recover` 不因连接错误自动重发任务。

通知为 `uncertain` 时，可能已经入队。先核对是否已收到；只有确认需要重新投递时使用 `recover <任务ID> --resend-notification`。外部队列与本地文件没有跨进程事务，不宣称严格 exactly-once。

断网或配额恢复后先read检查原会话。普通resume只恢复存活Pane的监听；需要发送继续指令时使用具体rework要求。Codex自身不可用时交付仍落盘，恢复后检查pending再验收；不以无限模型轮询代替恢复流程。通知RPC失败保留pending，响应不确定保留uncertain，不降级为旧的不可撤回投递。协调器不管理CBC CLI自身内部重试。

人工接管时只操作 task.json 中记录的 Herdr 会话和 Pane，并检查当前占用者。不要在协调器仍判定 `running` 时另发相同任务。需要停止时执行 `cancel` 并确认状态。

OpenCode昵称oc，面板同名；使用同一派工命令加--agent oc，原--agent opencode兼容，先读[OpenCode V2执行、审批与质量升级](references/opencode-cli.md)。保留原生TUI，通过官方CLI API提交和核对真实会话；稳定规则用持久会话指令注入。模型继承原生配置，effort按模型variant目录验证。oc交付明显低质或同一任务连续两次交付验收未通过时，由Codex按参考规则在原会话升级为GLM-5.3，再给出具体返工要求；网络、配额和审批问题不计为质量失败。审批优先官方API单次批准，恢复不重放原任务。

## 扩展边界

`agent-bridge agents` 查询已注册执行者。目前为CBC、ZCode、agy、opencode；不同执行端的能力与限制见对应参考文件。后续Agent须验证启动、真实会话恢复、状态事件和取消后再投入派工，注册名称本身不证明可用。

异常恢复时读取[正式恢复与隔离](references/recovery-safety.md)：优先recover对账；已提交轮次resume仅恢复观察；OC显式同轮重试、迟到交付、移动Pane认领、消息退役与未知终态隔离使用对应正式命令，不手改状态或重投规避。
