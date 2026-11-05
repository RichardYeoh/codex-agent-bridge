# CBC 精确回合与恢复

## 回执含义

`pane.run`退出0只证明输入传输成功；即使stdout为空，也不能宣称原生任务已接纳。新建或返工的CBC轮次启用`cbcTurnProtocol:1`，每次发送前保存独立attempt、任务书摘要和当前CBC进程证明。

接纳须核对task、round、attempt、原生session、Herdr服务、Pane、terminal、租约和实际输入。CBC 2.179.3的Hook prompt可能合并额外文本，不能假定与提交指针相同；桥接逐字核对受限原生历史文件中的用户指针，与当前Hook边界交叉证明。协调器日志只保存摘要、身份和文件指针，不复制原始任务文本。

原生Stop仅表示本轮响应结束。观察器还须确认没有后续用户输入、实时执行端为空闲、状态序号稳定、进程证明未改变，指定交付文件属于这一轮，才能进入`review_pending`。技术结果仍由Codex审查；失败的测试报告也可能是合法交付，不能自动accept。

## 常用恢复

所有命令先设置目标`AGENT_BRIDGE_STATE_DIR`，使用本工程`agent-bridge/bin/agent-bridge.js`，不手改`task.json`。

| 现场 | 支持的动作 | 禁止推断 |
|---|---|---|
| 投递返回不确定，但精确输入可见 | 新协议自动启动观察器；观察器丢失时`recover <task>`只重附观察 | CLI错误不代表输入未送达，不能重发 |
| 原生正在运行，观察超时或本地进程查询失败 | 检查身份、审批和资源后`resume <task>`，已提交轮次只恢复观察 | resume不是再次执行任务书 |
| 旧Hook缺少原生历史路径 | 先`reconcile-submission <task> --cbc-transcript <精确原生JSONL>`只读核对，再`recover`同参数 | 目录必须为该用户CBC原生项目存储，文件名/session/cwd及指针必须一致 |
| 同session收到手工新任务 | 停止旧轮自动结算，保留`native_turn_superseded`等证据 | 新任务的Hook与Stop不能倒配到旧轮 |
| 已有精确Stop，报告迟到 | `settle <task>`再次核对执行端/关闭证明后提交主审 | 文件存在不是本轮执行证明 |
| 主审完成 | `accept <task>`；主控再核实原生ID、进程、空闲及Pane归属后关闭本执行Pane | 不关闭主控、共享Herdr服务或其他执行端 |
| 关闭后有相关任务 | 沿用原worker-key，协调器核对并以登记的原生ID启动 | 不以标题或新任务ID替代session ID |

恢复命令的数组结果可能包含单任务错误；必须同时读取结果与任务状态，不能只看退出码0。

## 断网、限流与配额

原生可确认的Stop且没有交付时，会结合终端诊断区分quota、rate_limit、network与delivery_missing。终端文本只用于提示原因，不用于证明执行已经结束。出现审批只记录blocked，不自动放行或发送快捷键。

现有Hook安装项未启用StopFailure。如果CBC报错后没有Stop，桥接不能证明失败终态，只能在观察时限后保留blocked或submission_unknown。默认观察时限30分钟，可显式设置；`0`代表主动选择无时限。网络或额度恢复不自动重发任务、不自动换模型，不把本地观察停止解释为远端执行停止。

进程查询的暂时超时/读取错误最多重试3次；访问被拒、进程身份变化立即停止。诊断保留`processProofCode`，不输出原始进程命令行。最终仍无法核实时须处理该具体条件，不能用force绕过。

## 兼容与边界

- 新协议从下一次正式提交启用；不批量改写旧业务状态。旧未知提交仍有显式原生历史对账入口。历史task、attempt和交付全部保留。
- Herdr 0.9.5没有CBC官方`agent_session`引用。普通已关闭Pane的原ID恢复与共享服务重启后的Pane迁移是不同路径；后者缺少独立身份时仍拒绝自动认领，不冒充已实测通过。
- Hook/原生JSONL缺失、损坏、被替换或超出证据读取上限时不结算；需要显式证据核查，不删除历史以绕过。
- Herdr读取与`pane.run`之间没有服务端原子身份/审批CAS。提交前双次核验降低风险，但用户同时操纵同一TUI仍存在小窗口。桥接发送期间应避免人工同时输入；需要接管时先停止桥接投递。
- 主控验收与最后一次只读核对之间也不是跨进程事务。独立验收、accept前重新读取本轮证据是额外防线，不能保证任意外部并发操纵下完全无竞态。
- 关闭Pane只说明登记的执行端退出，不证明脱离该进程的仿真、编译或后台任务全部终止。
- 既有全局Hook定义指向本工程脚本时，脚本改动供下一次Hook调用使用；本轮未修改全局Hook设置，也未启用新事件类型。

社区方案和CBC官方API的评估见[Herdr社区与CBC接口评估](Herdr社区与CBC接口评估.md)。

## 2026-11-05：CBC启动前守卫诊断与有界读取重试

真实冷恢复任务首次提交被CBC_PROMPT_GUARD_REJECTED拒绝，attempt明确为rejected-before-input/inputWritten=false，任务回退failed/r0/submission=null。内部已有guardStage/processProofCode，但协调器没有将其写入拒绝日志和CLI错误，导致首败原因不可区分。原始错误不能追补为已确认的超时。

维护仅对指定Pane及其CBC进程执行一次只读核验，Node可执行文件、实际CBC脚本、PID/父子链与出生时间匹配，原方法耗时3403ms。该结果证明检查时进程身份可确认，不证明首次全套守卫成功，也不等于业务正文已投递。首次拒绝的具体底层异常已丢失，现有证据不能确定其发生环节。

修复内容：

- 将允许枚举中的guardStage、processProofCode、preflightReadAttempts同时保留到attempt、lastSubmissionRejection及CLI错误；不输出进程命令行、原始异常或凭据。新增可执行入口解析、原生元数据、Pane归属阶段，避免一律显示preflight。
- 写入前仅对进程查询的query-timeout重试一次，等待250ms后重新执行两次完整守卫，丢弃此前部分证明。每次查询原超时上限不变。最终失败仍为明确未写入；访问拒绝、身份不符、通用查询错误、审批或状态变化均不重试放行。
- 重试仅在pane.run之前；pane.run之后的丢回执仍submission_unknown，不重放。这与执行观察阶段已有的最多三次读取重试不同。

对failed/r0、无submission且有明确rejected-before-input证据的原任务，由业务主控冻结新工具、确认原CBC空闲及无审批后执行一次`resume <task-id>`。存活原Pane正常时无需重启、无force，不新建task/native或worker-key。该命令重新执行完整守卫后首次投递，保留旧拒绝attempt；若再被拒绝，读取三处一致的诊断字段，不手改状态或盲目循环。处于submission_unknown的任务不能套用本路径。

验证：完整回归533项，531通过、2历史跳过；最终阶段枚举细化后定向34/34，离线8/8。隔离真实Node CLI覆盖超时两次仍拒绝、三处诊断一致、未发送、随后普通resume保持同native且仅发送一次、首败字节不变。单元反例覆盖第二次检查超时后重做整组、重试间出现审批、拒绝访问/身份冲突不重试、诊断字段脱敏。未执行业务resume或写入业务状态，实际接续由业务主控验证。证据与新工具冻结在.local/cbc-guard-20261105，未提交推送。

## 2026-11-05：accept前的本地状态查询识别

真实review_pending/observed任务在accept时被readTurn判为superseded。首次只读定位确认：精确Stop之后的native JSONL包含两条command-caveat和一条`<command-name>/status</command-name>`，三条均为原生providerData.skipRun=true、agent=cli，父子记录连续且conversationRequestId相同；没有新的UserPromptSubmit Hook。旧逻辑把全部role=user消息当作执行输入，误把本地状态查询视为新模型回合。task中的旧stopped回执是先前观察结果，不代替accept时的新鲜读取。

修复只识别绑定Stop之后完整的一至两条caveat加一条无参数/status记录组：要求精确内容、skipRun严格为true、原生cli来源、同request、唯一记录ID、父子链连续、有序时间及原session/cwd。排除组只保留数量、时间和原始记录组SHA供审计，不改native JSONL。单独/status文本、参数、额外正文、缺标记、其他命令、身份变化、真实后续UserPromptSubmit均不因此放行；不泛化跳过全部skipRun记录。

accept拒绝现在返回CBC_ACCEPT_TURN_UNCONFIRMED及实际turn状态/原因，不再统一提示无法适用的unknown恢复。`reconcile-submission <task> --cbc-transcript <精确原生JSONL>`对protocol1/observed任务提供readTurn只读结果，明确taskMutated=false；对uncertain任务继续走原有准入对账判据。只读结果stopped不等于实时进程检查或技术验收通过，仍由主控决定后续accept。

维护期间现场另出现新的本地/model记录及空local-command-stdout，同样带skipRun。操作者及是否完成模型切换未确认，不能宣称出现了新业务，也不能将其视为无副作用状态查询。新规则对这种未支持的本地命令返回unconfirmed，保留原Stop及laterInputAt，不强行accept。当前真实文件只读结果已正确排除旧/status组三条，仍因后来的/model保留保护；六项task/attempt/prompt/report/Hook/native文件摘要在检查前后相同。不得修改原生记录或回滚业务状态来绕过。

验证证据区分：原生现场文件只读定位、当前磁盘CBC包2.180.0中CommandMessageUtils机制核查、脱敏真实三条/status夹具及隔离正式CLI测试。磁盘包版本不证明原运行进程加载版本，未升级或重启CBC。专项25/25，包含不完整/伪装/异身份/其他命令及真正后续输入反例，隔离CLI证明observed只读对账不写task、纯/status场景可accept、真实新输入仍拒绝。原业务未代执行对账命令或accept，接续先由原主控核清新增/model操作；不重发/rework/force/关闭worker。

本次工具源码与证据冻结位于.local/cbc-accept-20261105。保留此前CBC-GUARD未提交修改及新出现的Hark复审目录，不代修改复审资料，未提交推送。

最终完整回归537项，535通过、2历史跳过、0失败；离线验收8/8。155项工具源码冻结包含新增脱敏/status夹具。原/status误判已在隔离CLI验证修复，当前业务accept因新增/model仍待核实，二者结论分别保留。


### CBC-ACCEPT-02 最终补充：已完成的本地管理命令

用户确认/status、/model及此前空闲时/login均为手动本地管理操作。当前实现仅对绑定Stop之后、原生skipRun=true/agent=cli、同conversationRequestId及连续唯一message/parent链的完整本地命令组进行分类；/model与/login另须有匹配的local-command-stdout完成记录。不能仅凭命令文字或用户确认跳过证据。未知/未完成管理操作仍unconfirmed，真实新输入或新UserPromptSubmit仍阻止旧轮次accept。账号与模型变化须在下一次派工重新预检。

最终专项26/26；完整回归538项，536通过、2历史跳过、0失败；离线验收8/8。真实本地文件只读核验：/status及已完成/model分类后原轮次readTurn=stopped、laterInputAt=null，六项证据SHA前后不变；/login仅有隔离测试，本轮未以真实登录操作复验。未调用业务accept或操作Pane，不能把只读stopped称为真实验收成功。

正式只读路径：reconcile-submission <task-id> --cbc-transcript <该原生会话jsonl>，对observed协议1任务仅返回readOnly=true/taskMutated=false及回合证据，不连接终端或更改状态。原主控重新冻结工具并核对当前仍stopped、身份与独立审阅后，自行决定官方accept；无需重发或resume来处理已完成的管理命令。
