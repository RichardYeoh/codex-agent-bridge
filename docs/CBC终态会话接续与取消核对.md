# CBC终态会话接续与取消核对

## 当前补充（2026-11-04）

Hark整改后，首次ZCode cancel也不再调用无法按command条件核实的全局stop；CBC/AGY登记执行端仍存活时同样不盲发Esc。关闭原生执行端后的精确证明、终态对账和保留资源隔离的abandon出口见[异常恢复与资源隔离](异常恢复与资源隔离.md)。以下11-03的“首次cancel行为不变”属于当日实现历史，不作为当前命令说明。

## 适用范围

2026-11-03补充CBC已取消任务的原生会话接续，以及旧ZCode任务在Pane缺失时的取消确认。技术验收状态、执行会话身份和取消请求分别处理。维护验证仅使用隔离传输；真实业务恢复由原主控执行。

## CBC原会话接续

`dispatch --resume-task <旧任务ID>`在同一状态根读取指定旧任务的真实workerSessionId。当前仅支持CBC，旧任务须为accepted或cancelled，且项目目录、Herdr服务、worker-key、策略及权限配置兼容。原Pane存活时核验终端、实际会话回执及空闲状态；Pane已关闭时按捕获的原生ID重建。条件不满足时报错，不回退新建空白会话。

```powershell
$env:AGENT_BRIDGE_STATE_DIR = '<原业务状态根>'
$bridge = '<维护工程>/agent-bridge/bin/agent-bridge.js'
node $bridge dispatch --agent cbc --task-id <新任务ID> `
  --cwd <业务目录> --session <原Herdr服务> --workspace <原Workspace> --pane <主控Pane> `
  --worker-key <原绑定键> --resume-task <已取消或已验收的旧任务ID> `
  --spec-file <已批准的新任务规格JSON> --codex-thread <原主控线程ID>
```

继续使用同一worker-key。不传--new-session，不把旧cancelled任务改为accepted，不对已取消任务直接resume/rework。新任务ID与原生会话ID彼此独立。取消后的新任务强制完整任务书，原会话历史保留，但未验收结果不能作为可信增量。已有其他未闭合任务占用同一原生会话时拒绝接续。

自动按worker-key选取上下文时，也会读取旧任务实际cancelled状态，不再只依据交付回执中的lastStatus。sessions输出新增actualTaskStatus，显示真实旧任务状态；lastStatus继续保留当时交付回执，不伪造accepted。明确不得新建会话的任务优先使用--resume-task。

## ZCode取消确认与串行门禁

旧ZCode任务已进入cancel_pending、但原Pane不存在时，使用新版协调器：

```powershell
node $bridge recover <旧ZCode任务ID>
node $bridge status <旧ZCode任务ID>
```

该分支先检查本地已持久化的原生命令准入回执。原命令为sendText、journal为acknowledged、回执精确匹配command/session且为failed/modelUnavailable、无接纳结果、具有有效revisionAtDecision和时间戳时，可证明该命令未获准执行。还需核对task/round/Pane/terminal/正文摘要、已观察提交、观察器和worker已退出、无相冲突执行证据、无其他任务或租约占用。满足时直接按正式取消流程收口，无需Desktop在线或再次配对；证据source为persisted-command-ack，仅证明原命令未获准执行，不声称整个原生会话空闲。

不具备上述完整拒绝回执时，仍只读连接原会话，attach使用create:false，通过原命令inbox及权威投影核实命令处置，检查无activeWorks、队列、审批、Hook审批或其他非空闲路由。绑定包含原session、task、round、Pane、terminal和命令正文摘要。accepted命令必须获得匹配的权威终态，不能用空窗口、Desktop退出或Pane缺失代替证明。提交不确定、身份/租约冲突或正向执行证据均不得使用离线路径。

证据齐全后由公共取消模块收口为cancelled、保留原生会话和历史，并解除默认串行占用。该核对不发送sendText、stop、createSession或技术返工；重复cancel_pending的cancel也仅进入核对，首次cancel的既有行为不变。不是恢复ZCode业务，也不是技术验收。

原命令查询unknown、身份/摘要不符、原生活动/队列/审批非空或Relay被占用时，继续保留cancel_pending及真实原因。遇本地占用或KICKED不循环争抢；由业务主控报告并协调释放，不用--parallel、手改状态或伪造accepted绕过。只有确认旧任务cancelled后，才继续普通串行CBC派工。

## 验证与限制

新增CBC9项、ZCode取消6项；与既有上下文、调度、取消回归合计42/42通过。实际执行隔离CLI dispatch验证--resume-task沿用原session、完整提示、只提交一次且无Pane创建；隔离CLI recover验证无Herdr输入/原生命令写入便可按证据收口。旧任务和旧交付回执字节保持不变。覆盖未知提交、外来活动、审批、队列、会话/终端/策略/租约冲突、陈旧台账及并发替换。

全量230项中229通过、1跳过；既有端到端验收8/8。跳过项仍为此前已取消并归档的Windows Tunnel客户端doctor。所有原生传输均为隔离替身，没有连接或操作真实业务任务；隔离通过不能宣称真实业务已经派发或模型可用。结果和基线位于.local/cbc-terminal-reuse-20261103。

协调器为每次调用读取源码的独立进程，无需重启主控或安装技能。取消确认无需重建ZCode Pane；CBC旧Pane不存在时由正式dispatch按原会话ID重建。此前ZCode执行恢复维护保持停止，本次仅交付取消确认及CBC终态续用。

## 2026-11-03离线取消补修

修复先前即使已有明确拒绝回执仍强制配对的疏漏。新增6项测试，相关取消与CBC接续34/34；全量236项中235通过、1跳过，既有验收8/8。新增覆盖Desktop配对超时条件下零连接收口、错误/缺失/接纳/未知回执拒绝、活动和身份/租约冲突拒绝、旧保守不确定投影以及真实协调器CLI隔离调用。测试均不连接远端模型。

真实旧任务只读核对已返回confirmed=true/source=persisted-command-ack，说明具备离线收口证据；维护未执行业务recover或派单，不能把该只读结果记为任务已cancelled。由原业务主控在原状态根执行上述recover，再核实status为cancelled后按正式CBC原会话接续流程派单。无需重新打开ZCode。证据位于.local/zcode-offline-cancel-20261103。

## 2026-11-04持久化执行终态失败的离线收口

补充已获准执行后失败的原命令：当前轮命令journal为terminal/failed、接纳回执精确匹配，且同轮观测包含同session/command/Pane/terminal的权威turnHeader及failed终态、结束时间、行号、seq和logEpoch，才具备终态证明。provider错误码和文字本身不构成证据；错误的recoverable标记也不推翻明确的终态头。

该分支还要求本地watcher与绑定worker均已退出；Herdr原Pane明确pane_not_found，现有Pane列表没有原terminal或同原生会话；无其他任务或租约占用。取消中断留下的stop_unconfirmed/null command投影仅在其他身份均匹配、worker已退出时允许作为无确定执行结论的旧投影，不能覆盖原命令的权威终态。较新的command、working或untracked_command_active一律拒绝。

证据齐全后，正式recover或已有cancel_pending的cancel不连接Desktop，按公共取消模块确认cancelled，证据source为persisted-terminal-failure。落盘前再次检查任务/轮次/命令、证据摘要及本地关闭条件；过程中身份或终态变化则拒绝。仅证明原命令已经失败结束，不声称远端整个会话空闲；不重发、不stop、不createSession，也不技术accept。

新增7项测试，相关取消32/32；全量258项中257通过、1跳过，既有验收8/8。覆盖旧轮/命令/会话证据拒绝、非权威终态拒绝、活动/租约/并发替换保护、Pane移动/重新附着/权限拒绝，以及隔离CLI仅用本地只读Pane查询收口。

本次受明确授权，在独立验证状态根执行一次官方recover，实际退出0并将r2取消请求收口为cancelled；原生绑定、任务规格及旧历史保留，r1/r2命令、观测和worker状态摘要不变。只读串行准入检查通过，没有派CBC或操作EDA/生产文件。私有实际命令、回执及保留性证据位于.local/zcode-terminal-cancel-20261104；完成结果仅入队给原独立验证线程，不resume。
