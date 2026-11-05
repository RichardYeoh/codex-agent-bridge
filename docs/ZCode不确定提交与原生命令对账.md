# ZCode不确定提交与原生命令对账

日期：2026-11-05。维护编号：BRIDGE-ISSUE-20261105-IDIV-ZCODE-ACK-02。

最新状态：业务主控已确认FIX4真实recover及原会话rework接续通过，见文末闭环记录。前述单次诊断已完成，不应重复连接采证；旧失败和诊断保留。以下各阶段的“待验证”描述为当时状态。

## 问题与范围

正式投递的原生命令已accepted/startNow并执行结束，但本地输入返回值为null，协调任务留在submission_unknown。历史底层CLI退出码未保存，因此不能确定该次null来自成功空stdout或其他传输情形。旧recover没有ZCode不确定准入对账分支，仅返回人工处理提示。

本次修复分开处理传输与原生事实，不补写历史本地传输成功。仅覆盖当前精确命令已completedSuccess且规范报告存在、当前包装器存活空闲的恢复。completedSuccess表示原生回合结束；报告中的技术FAIL仍由主控返工，不是技术accept。

## 实现

- lib/zcode-prompt.js请求Herdr现有typed CLI回执，保留exitCode与emptyStdout；零退出码空响应仅记text_queued/nativeAcceptanceConfirmed=false。裸null、缺字段、非零、负响应与异常继续保留uncertain，不自动重发。为今后失败保存最小transportDiagnostic；不能追补本轮未记录的退出码。
- lib/zcode-reconciliation.js校验规范task/round/attempt/native/command/Pane/terminal、原prompt与attempt及远端envelope正文SHA、ACK inputId、command摘要、observerGeneration、租约、精确终态header/seq/logEpoch、报告时间与摘要、当前包装器PID/出生时间/脚本和Herdr状态序列。
- 正式recover在任务及协调锁内调用此分支。先完成本地校验，确保没有其他存活watcher或同会话未收口owner；然后单次连接，只读查询原command inbox和权威当前会话。必须无activeWorks、queue、审批或其他输入，终态header与持久化证明一致。连接拒绝/占用/失败不循环抢Relay。
- 远端对账后再次核对所有本地证据SHA、当前PID、出生时间及Herdr状态序列。任一变化拒绝落盘。通过后另存独立reconciliation证明，仅将任务协调状态改为observed/review_pending。原uncertain attempt journal、原命令、历史首败及报告原样保留；不伪造inputReceipt、accepted或本地传输成功。

## 官方使用

在原状态根环境中执行：

~~~powershell
$env:AGENT_BRIDGE_STATE_DIR = '<业务原状态根>'
node <bridge-root>/agent-bridge/bin/agent-bridge.js recover <task-id>
~~~

该操作不发正文、不createSession、不stop、不重启包装器或共享服务。当前worker可保持运行，无需重载FIX2。执行前由业务主控重新冻结源码并确保独占该原生会话的观察权；勿同时打开Web远控占用Relay。成功返回actions中的review_pending后，再检查status及规范报告，由主控决定官方rework，技术FAIL不应accept。

recover处理单任务错误时可能整体exit0但结果项含error；必须检查返回对象，不只检查进程退出码。证据缺失、执行仍在途、失败/中断终态、报告晚于证明窗口、正文因压缩被重写导致attempt hash不一致等情况均拒绝本分支；不得force重放或将手工后续工作套入旧轮。

## 验证

- 定向测试：node --test agent-bridge/test/zcode-reconciliation.test.js agent-bridge/test/hark-zcode-prompt.test.js，12/12。
- 完整回归：agent-bridge目录执行node --test --test-concurrency=4 test/*.test.js，516项，514通过、0失败、2历史跳过。
- 离线验收npm run test:e2e：8/8；差异及语法检查通过。
- 独立Node CLI真实执行覆盖exit0空stdout，证明仅限传输替身，不是实际Herdr写入。正式recover CLI在隔离适配器下运行，确保未提供任何远端命令或终端写入能力。
- 反例包含轮次/原生/命令/terminal/租约/正文hash/报告不匹配、活watcher、缺状态序列、PID复用、审批/排队/在途活动、离线、旧epoch、对账期间报告/Pane/状态变化、重复恢复。
- 业务现有文件仅通过inspectLocal只读核验，精确绑定与报告SHA匹配。未读取实时业务Pane/PID、未连接业务Relay、未代执行recover、未改task、未技术验收；不能宣称真实业务恢复已通过。

本地证据与本轮152项源码冻结：.local/zcode-ack-recovery-20261105/。FIX1和此前工作保留，未提交推送。远端快照与本地提交没有跨进程原子事务；前后核验不能授权其他操作者并发向同一原生会话投递。

## FIX2真实拒绝后的单次诊断补充

现场第一次正式recover在native inbox判据处拒绝，尚未验证fresh terminal。官方[command.ts](https://github.com/zai-org/ZCode/blob/main/packages/shared/src/zcode-protocol-v4/command.ts)与已有本地协议快照都将CommandAck.result声明为可选。先前隔离测试使用与提交ACK相同的查询结果，未覆盖真实查询差异；目前没有该次原始响应，不能断言只是缺result，也不能把拒绝解释为没有执行。FIX2的恢复准入判据保持不变。

新增官方只读诊断入口：

~~~powershell
$env:AGENT_BRIDGE_STATE_DIR = '<业务原状态根>'
node <bridge-root>/agent-bridge/bin/agent-bridge.js diagnose-zcode-admission <task-id>
~~~

先执行与恢复相同的本地绑定、空闲进程和租约检查；连接前以wx创建一次性诊断占位，仅attach已有项目并执行一次queryConversationCommandsV4。没有subscribe、send、create、stop、恢复或通知副作用。完整RPC返回对象及其SHA只保存到当前task目录的round-NNN-zcode-admission-diagnostic.json；不会保存连接header、配置或凭据，也不将原始响应打印到stdout。返回对象只含文件位置、捕获状态、摘要和本地证据是否保持一致。RPC本身若返回额外字段，会原样私有保存以供协议审查，禁止上传公开仓库。

同轮再次调用返回已有诊断记录且connected=false；prepared、失败、崩溃或结果不确定均不自动重试。不删除该记录以绕过一次性限制。查询前后本地证据变化会标记localEvidenceStable=false，不更改task状态或原attempt/command/report。原生身份、摘要、权威终态和技术验收要求均未放宽。拿到真实响应后，才按实际契约补解析和脱敏回归fixture；本阶段不再次运行recover。

本次验证：zcode-reconciliation专项9/9（含正式diagnose CLI及重复调用），限并发完整519项=517通过/2跳过/0失败，离线8/8。缺result、未知形态和网络异常均只采证，不完成业务恢复。维护未连接业务Relay、未更改业务状态，真实诊断由Sol执行。当前152项源码冻结及日志在.local/zcode-query-diagnostic-20261105/。

## DIAG1真实响应与FIX3摘要ACK兼容

已核诊断文件及response摘要与反馈一致，localEvidenceStable=true。真实响应的results项含精确sessionId/commandId key；result为commandId、status=accepted、revisionAtDecision=0，未提供可选的result明细。该事实与官方CommandAck.result optional一致；不改变已执行事实。

FIX3在verifyNative增加摘要ACK分支：queryAdmission仍精确匹配session/command；要求accepted或duplicate、非负整数revisionAtDecision与原始ACK相同。只有result属性缺省才按summary处理；若明确存在，必须是同inputId及同delivery的inputAccepted，null、冲突或其他类型仍拒绝。原本持久化的完整inputAccepted、attempt/prompt/envelope摘要、租约、原生ID、Pane/terminal、进程与新鲜权威终态全部仍为必需；缺result不单独授予review_pending。新证明标记queryAckKind=summary，原样保存查询摘要，不补造result。

新增test/fixtures/zcode-command-query-summary.json，严格从真实响应仅替换原生session与command ID产生，形态等价核验通过；未经脱敏的原始响应保留业务私有目录，不入库。新增测试覆盖摘要成功、显式null/冲突inputId/delivery/revision/原生key/状态、原始完整ACK缺失和旧终态水位；正式recover CLI采用该真实形态替身。专项11/11、完整限并发521项=519通过/2跳过/0失败、离线8/8。维护仍未连接业务Relay或改业务task，真实恢复待业务主控执行。

接续：重新冻结.local/zcode-query-summary-20261105/source-freeze.json中的153项，在原状态根普通recover原task，不带force，无需再次diagnose或重启worker。检查结果数组是否含error及实际status；只有正式进入review_pending后才由主控决定返工。历史传输不确定记录和技术FAIL保持，未提交推送本轮源码。

## FIX3真实终态拒绝与完整字段诊断

FIX3实际回执表明inbox已通过，fresh terminal复合条件拒绝；没有记录fresh返回值，无法确定具体字段。上述FIX3接续建议在本现场已执行一次，当前不应重复recover，也不重复已有admission诊断。此次修复首先补齐可观察性，未认定epoch重置、终态消失或原执行失效，未放宽恢复条件。

`verifyNative`逐项比较seen、terminal、state、headerKind、sourceCommandId、headerRowId、endedAt、logEpoch和seq。每项保存expected、actual、actualType和pass；seq仍要求整数且不低于持久化水位，其余维持精确匹配。正常recover今后也会在失败结果中返回diagnosticFile和failedChecks，避免再丢失首次失败证据。

新增一次性诊断入口：

~~~powershell
$env:AGENT_BRIDGE_STATE_DIR = '<业务原状态根>'
node <bridge-root>/agent-bridge/bin/agent-bridge.js diagnose-zcode-terminal <task-id>
~~~

该命令先核实当前本地身份、租约、包装器进程、空闲状态与证据摘要；只进行一次连接，在该连接内查询原command准入、订阅已有会话并读取终态。尾窗缺头时最多使用既有50页只读历史查询上限，不发送模型命令，不新建、恢复、停止或取消会话。诊断不调用recover，不更新task、旧attempt、command、observation、report或DIAG1。无需重启原wrapper；业务主控须先确保本方没有其他观察器及新的活动工作。

私有证据分为两个文件：

- `round-NNN-zcode-terminal-diagnostic.json`：一次性占位、身份与来源摘要、前后本地核验、执行阶段、取证文件路径和SHA。已存在记录时返回reused/connected=false，包括prepared、失败或中断记录，不删除占位后重试。
- `round-NNN-zcode-native-verification-<uuid>.json`：查询ACK、期望终态、实际turn及摘要、全部比较结果、快照水位与活动计数、历史页水位和turnHeader、释放连接的结果。文件限2MiB；不保存队列正文、审批问题、模型配置或连接凭据，不向stdout打印原始内容。历史查询在返回turn之前拒绝时，也保留已收到的页水位。

`status=captured`只说明诊断记录已生成；须结合stage、terminalCaptured、nativeChecksPassed、failedChecks、localEvidenceStable判断实际取得了什么证据，不能解释为恢复或验收通过。`taskMutated=false`表示该命令未写任务状态；外部并发变化另由localEvidenceStable反映。若仍在connect、inbox或subscribe阶段，不能声称已取得fresh terminal。原生检查通过但前后本地核验不一致时，同样不得收口。

验证：专项15/15；完整回归525项，523通过、2历史跳过、0失败；离线验收8/8。新增反例覆盖多字段同时不符、类型差异、历史epoch拒绝前的取证、审批/队列正文过滤及重复调用不连接。隔离真实Node CLI覆盖recover失败返回字段诊断、新命令取证与幂等；网络与Herdr为替身，不是业务Relay实测。日志与153项源码冻结位于`.local/zcode-terminal-diagnostic-20261105/`。

维护仅只读核对业务本地回执，未连接业务Relay、未执行业务recover或修改业务task。实际字段差异等待业务主控按新入口单次取证，原报告技术FAIL及旧传输uncertain保持；不commit/push。

## FIX4：跨投影代际恢复的正式证明路径

### 真实差异与原因

两份诊断文件SHA与业务反馈一致。原始和新鲜历史都为同一sourceCommandId、turnId/entityId/productTurnId、rowId=1、completedSuccess。endedAt由1793816229805变成1793816229776，差值为−29ms；logEpoch从旧代际变为新代际；旧seq=74375，新快照seq=362，权威历史页atSeq=380且与新快照同epoch。历史页不是旧缓存；此次订阅退出前同代快照也推进到380。本地七项核心证据摘要保持不变。

官方源码固定版本`3c5b227649371507ddc4eb46ac5133afe6db1cab`表明：

- [v4-gateway.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts)为新publisher生成进程内随机logEpoch；[projection-state.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/projection-state.ts)从seq=0初始化。不同epoch的seq不是同一递增序列。
- [transcript-hydration.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts)按持久消息和part结束时间重建TurnComplete事件；[product-projection.ts](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts)将事件时间映射为header.endedAt。该展示时间不保证等于live运行结束事件时间。
- [协议说明](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/docs/zcode-protocol.md)要求失效base通过完整snapshot恢复，完成事实来自带sourceCommandId的权威投影，不能仅凭ACK。

因此，旧桥接把跨epoch水位及展示时间当作持久身份不变量，属于证明条件设计错误。真实差异与投影重建机制一致；没有Host完整生命周期日志，不能进一步认定是用户重启、Host切换还是publisher重新创建触发，也没有修改安装包。原执行完成事实和技术FAIL结论均不受此次拒绝影响。

### 修复与边界

同epoch保留原来的endedAt精确一致、seq不回退等条件。跨epoch不设置29ms或其他任意容差，也不直接忽略失败字段，而采用独立`proofMode=rebuilt-history`：

1. 原task/round/attempt/session/command、完整原ACK、正文与报告摘要、租约、进程、observerGeneration、当前空闲与无其他owner等原有条件全部保留。
2. 即使新尾窗已有匹配header，也必须读取当前权威历史。要求sourceCommandId以及turnId/entityId/productTurnId、origin/executionKind、rowId精确匹配；缺字段或冲突拒绝。当前header和解析结果均须completedSuccess。
3. 历史页epoch必须与本次新快照一致，seq不得低于本次快照；不与旧epoch的seq作大小比较。createdAt/startedAt/endedAt须为整数、按顺序且位于原命令issuedAt至原终态observation记录时间之间，防止后续执行倒配旧轮。
4. 在同一连接内再作一次有界历史读取，确认header完整摘要不变且当前代际seq不回退；随后复核当前会话仍无活动/排队/审批、epoch未变化。本地全部证据、PID、出生时间与Herdr状态序列再次匹配后，才可进入review_pending。

旧严格比较结果仍写入historicalComparison供审计；原始和新鲜header及水位都保存，不覆盖旧observation/command/report或传输uncertain日志。元数据缺失、同代时间变化、历史不稳、当前水位不连续、会话活动或连接失败仍拒绝。没有跨进程原子锁可以禁止外部客户端并发投递，业务主控仍须独占原会话操作权。

### 验证和接续

新增`test/fixtures/zcode-rebuilt-terminal.json`来自本次实际证据的必要字段，仅将会话、命令、轮次和epoch标识脱敏；保留精确时间差和水位变化。真实形态隔离恢复、原证据保留、18种身份/时间/水位/活动/历史变化反例以及第二次读取断网均通过。正式recover的真实Node CLI在只读适配器替身下通过，不能调用写入接口；这不是业务Relay实测。

初次专项18/18；增加正式CLI验证后完整回归529项，527通过、2历史跳过、0失败；离线验收8/8。源码、官方证据快照与日志位于`.local/zcode-projection-recovery-20261105/`，工具冻结154项。业务仅只读核对原文件，未连接Relay、未改task、未代投递，未commit/push。

由Sol更新工具冻结后，在原状态根执行一次普通`recover <原task-id>`；无需重启wrapper、无需force或再次diagnose。必须检查结果数组没有error且任务确已review_pending，之后由Sol按原技术FAIL决定正式rework。恢复失败时读取本次diagnosticFile/stage，不自动重连或重投；本轮维护不解除业务Goal的blocked，不宣称真实恢复成功。

## 真实运行闭环与公开案例范围

业务主控反馈FIX4-REAL-PASS：154/154工具来源冻结后，一次官方recover退出0且结果无error，实际进入review_pending/r1；旧attempt、command、observation、state、report及两份诊断七项SHA不变。随后主控按原技术FAIL通过官方rework在原native接续R2，取得accepted/startNow，任务进入running/r2。本记录依据业务主控的真实回执反馈；维护未额外连接Relay、操作在途R2或代做技术验收，不把桥接恢复通过等同于产品通过。

本次公开交付保留以下真实故障链及对应修复，不只保留最终成功结果：

| 真实现象 | 修复与证据边界 |
|---|---|
| 新会话已创建，包装器因自定义Herdr来源缺少原生引用而退出 | 缺省引用由精确租约/进程/原生快照补证，显式冲突仍拒绝；详见自定义身份说明 |
| 原生命令已接纳并完成，本地输入回执未知，任务卡submission_unknown | 新增精确原生命令对账；今后保存typed CLI回执。历史null的唯一底层成因未确认，不补造传输成功 |
| FIX2真实recover拒绝inbox，DIAG1确认查询ACK省略可选result | FIX3兼容摘要ACK，保留原始完整ACK及其他门禁；真实响应脱敏fixture纳入测试 |
| FIX3真实recover拒绝fresh terminal，诊断显示时间及投影代际变化 | FIX4使用跨代权威历史证明；真实脱敏fixture、拒绝反例及最终业务恢复回执结论保留 |

公开仓库包括修复源码、自动化测试、脱敏fixture和本说明。原始业务任务、完整RPC回执、原生身份、连接配置、凭据及本机日志不入库，继续保存在业务私有状态根或维护工程的忽略目录。此次发布不改变现有业务配置，不重启执行端；R2后续结果由业务主控负责。
