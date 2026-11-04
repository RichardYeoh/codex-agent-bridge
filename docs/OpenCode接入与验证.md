# OpenCode接入与验证

## 接入方式

执行端名称为`opencode`。当前适配OpenCode V2 2.2.0，保留Herdr Pane中的原生TUI、工具过程、审批和人工接管。Node启动器只负责CLI生命周期和状态核对；模型执行由OpenCode原生后台服务承担。无需浏览器、ACP、认证复制或全局配置改写，也不安装项目插件。

官方入口为V2 `opencode api`。创建与读取会话使用`session.create/get`，启动TUI使用`--session <真实ID>`；提交使用`session.prompt`，请求中断使用`session.interrupt`。原生TUI连接同一共享服务并显示同一会话，提交不依赖界面焦点。恢复只观察原执行，不重放原任务。关闭Pane不代表服务内任务已经结束。

稳定规则通过`experimental.session.instructions.entry.put`写入`codex-agent-bridge`键；内容未变时不重复写入。该接口保留规则并支持压缩后的上下文，但不是操作系统沙箱。每轮继续使用既有task-spec-v1、完整/差量提示、租约、任务轮次、通知和独立验收。接口属于上游实验API，升级后必须复验，V1不在当前支持范围内。

官方依据：[V2 CLI与共享服务](https://opencode.ai/v2/docs/cli/)、[V2 API](https://opencode.ai/v2/docs/api)、[会话指令接口](https://opencode.ai/v2/docs/build/plugins/server/#sessions)。核验版本为[v2.2.0](https://github.com/anomalyco/opencode/tree/v2.2.0)，提交1097e2668b1e08ad63bdf0b1c4860b9bc01e420c。V1的`/session`、插件格式及命令参数不能直接用于本实现。

## 使用与配置

昵称为`oc`，注册名为oc，多实例为oc-2等；Codex在派工后把Pane标题设置为“注册名 · 用途”，例如“oc · JPEG仿真验证”。`--agent oc`与`--agent opencode`等价，sessions查询也接受两者。内部持久类型仍为opencode，既有会话与绑定无需迁移。

```powershell
node $bridge sessions --cwd <业务目录> --agent opencode
node $bridge dispatch --agent opencode --session <Herdr服务> --pane <Codex主Pane> `
  --cwd <业务目录> --codex-thread <Codex线程> --spec-file <任务规格JSON>
```

首次登录与模型配置由OpenCode自身管理。缺省沿用其原生配置；可指定`--model provider/model`和`--effort <variant>`，或使用`provider/model#variant`。适配器根据当前模型目录核对variant，不能把所有模型的最高档都写成max。仅设置目标执行会话，不更改全局默认。Windows默认定位APPDATA/npm/node_modules/@opencode/cli/bin/opencode.exe；其他安装位置通过AGENT_BRIDGE_OPENCODE指定实际可执行文件。

默认skipPermissions写入该执行会话的allow规则。需要保留原生审批时传`--no-skip-permissions --permission-mode native`；需要逐项审批时选择`ask`。旧公共默认值acceptEdits在该适配器中兼容为继承原生策略，不表示自动批准编辑。权限规则仅作用于桥接创建的执行会话，工作范围仍由任务规格限定。

审批处理必须先核对任务、session、requestID、动作和资源范围。读取与答复均可通过CLI完成：

```powershell
opencode api session.permission.list --param sessionID=<workerSessionId>
opencode api session.permission.reply --param sessionID=<workerSessionId> `
  --param requestID=<已核实requestID> --data '{"decision":"once"}'
node $bridge resume <任务ID>
```

只批准用户已授权的具体动作，优先once；超出授权时由用户决定。表单问题须单独读取对应session.form接口，不能当作权限自动批准。人工接管使用任务保存的Pane或`opencode --session <workerSessionId> <cwd>`；同一会话避免并行写入。接管期间不要把桥接Pane切换到无关会话。

## 状态与恢复

用户预授权的质量升级由Codex验收时判断：oc明显低质，或同一任务连续两次真实交付未达正式要求时，下一轮在同一session切换到GLM-5.3完整版。每轮审查证据存任务目录round-NNN-review.md；网络、额度、繁忙、审批及未确认提交不计为质量失败。当前核验默认为magpie下的DeepSeek V4.1 Flash，升级目标为同Provider的magpie/raccoon/sn-glm-5-3，执行时重新核对模型目录。该规则不修改OpenCode全局默认，不影响CBC、agy或ZCode。

```powershell
node $bridge rework <任务ID> --model <已核实的Provider/GLM-5.3模型ID> --prompt-file <返工要求>
```

rework的模型参数当前只支持oc，先持久保存目标模型，再通过prepareSubmission按原会话切换，不另建空白会话。未指定新effort时清除旧模型variant绑定；显式effort必须由目标模型支持。后续同任务返工保持升级后的模型。既已使用GLM-5.3时不反复切换或无限重派，具体执行和例外见[Skill参考](../agent-bridge/skills/delegate-worker/references/opencode-cli.md)。

状态来自真实会话、active集合、待审批请求、表单和未投递输入队列。当前轮失败映射为blocked/execution_failed；API读取连续失败3次后才上报blocked/api_unavailable，单次失败不改变原生执行状态。观察器启动时API不可用仍会启动已登记会话的原生TUI，并继续重试只读核对。窗口与API断开时原任务可能仍执行，保留原会话、轮次和现场，不自动换模型或重发。

观察器以程序核对快照，活跃时约1秒间隔、其他未闭合状态约3秒；每次还包含CLI/API耗时。状态未变化不重复上报，验收或取消后仅检查本地租约，不继续API轮询。此方法不产生模型轮次，但存在本地CLI进程和API开销。当前CLI的api事件订阅未得到可用流式输出，因此未将该入口当作可靠事件源；后续有必要时可改为官方流式客户端。

派工返回只确认准入和启动；交付后由公共watcher进入review_pending并通知主控。回执包含当前任务、轮次、Pane、Herdr服务和原生session。旧轮空闲快照不能结束新提交轮次。任务提交使用稳定准入ID；结果不确定时保持submission_unknown，禁止盲目重试。

`cancel`先核对保存的原生sessionID及工作目录。连续两次快照均无active、待审批、表单和未投递输入时，才确认原生执行已停止。Pane关闭本身不构成取消证据。原生outcome为failed也可能已经停止，取消确认不代表技术验收通过，也不撤销已有文件修改。服务重启后的原生会话数据必须保留。

原生仍活跃时，取消只可作用于本任务当前准入所启动的执行。Pane存在时核对其session、terminal和任务租约；Pane明确缺失时，适配器再核对原任务/轮次、原生会话目录、当前Pane租约及同一原生session的未闭合属主，并从原生消息记录确认当前执行仍对应本任务的稳定准入ID。随后再次读取同一原生回合指纹；两次指纹不一致时不发送中断。另一个未闭合任务持有同一原生会话时禁止中断。

待审批请求、表单或额外的未投递用户/控制输入存在时，不中断原生执行、不代替用户批准或拒绝，也不取消外来输入。若session.inbox.list仅含本任务当前准入ID且会话空闲，可通过session.inbox.cancel撤销该未投递准入；存在其他输入时保持cancel_pending并返回待处理ID，待用户处置。对仍活跃且已核实为本任务准入的执行，session.interrupt最多按同一turnFingerprint执行有限重试；每次重试前重新确认任务租约、无审批/表单/新输入且回合指纹未变。超过持久化尝试上限或证据变化后停止重试并保留cancel_pending。

对cancel_pending执行`recover`不自动重启TUI、不提交提示词，也不把Pane关闭推断为取消。原生状态与同一轮回合指纹对账后，只有两次原生快照均空闲且没有审批、表单或未投递输入时才收口；身份或API证据不足时继续保留cancel_pending及原因。对于旧任务没有可靠中断记录的情形，先按原session、目录和本任务准入ID对账，不能生成新准入ID。

```powershell
$env:AGENT_BRIDGE_STATE_DIR = '<原任务状态根>'
$bridge = Join-Path '<维护工程目录>' 'agent-bridge/bin/agent-bridge.js'
node $bridge recover <旧任务ID>
node $bridge status <旧任务ID>
```

维护更新后直接调用新版命令即可，无需重启主控CLI或OpenCode。不得以关闭窗口为依据手改task.json；只有确认cancelled后才继续派工，相关任务仍可按登记的原生ID恢复上下文。

### 失败回合、提交对账与晚到交付

`resume <任务ID>`只恢复观察或继续处理状态，不会自动重发失败回合。用户确认需在同一session重试当前轮时，显式执行`resume <任务ID> --retry-failed`。命令仅接受本轮原生outcome为failed、idle时间晚于本轮准入时间和失败基线、无active/审批/表单/未投递输入、原生最近user消息仍对应当前桥接准入ID，且session、目录和Pane租约未变的任务。重试保留round和任务书路径，最多提交2个有独立attemptNumber和稳定消息ID的显式尝试；新准入ID写入本地journal后才调用session.prompt。普通resume、recover及观察器均不触发重试。

如果session.prompt回执丢失，当前attempt按sending保留。`recover <任务ID>`通过session.inbox.list和session.message.get按原session、准入ID对账：已在原生Inbox或消息记录中找到时恢复观察；只在本地journal仍为prepared、且能够证明尚未调用prompt时报告not_sent；发送已开始但原生证据未能核实则保持submission_unknown，不换attemptNumber、不重发。API不可用、身份不符、审批/表单或外来输入存在时继续阻塞并说明原因。

`settle <任务ID>`只读核对当前轮原生执行已结束、没有active/审批/表单/未投递输入且本轮交付文件已写入后，将delivery_missing转为review_pending并通知Codex。该命令不提交提示词、不改变round、不重建会话。报告缺失或原生完成证据不足时保持原状态。

长任务可通过`observe <任务ID> --wait-timeout-ms <毫秒>`调整观察窗口并重新附着原session；命令写入变更历史，不提交新提示词。watcher传输故障或Herdr短暂不可用不能作为执行失败依据，recover保持原running及存活watcher绑定不变。

### Pane身份与观察器生命周期

`resume --force`仅在worker确认不存在时允许重建Pane。原Pane仍存在但身份、terminal或session不匹配时，保持现场并拒绝启动第二个TUI/观察器；由主控核实旧Pane与租约后决定如何恢复。新worker启动时若只读API暂时不可用，仍运行保存的原生TUI并退避重试状态读取；只有启动器确认新Pane无法运行或身份无效时才进入清理路径。

此桥接与Herdr官方OpenCode集成尚未经过共存验证。接入本桥接的Pane不应同时加载Herdr官方OpenCode插件/集成，以避免双方写入同一Pane的执行状态或绕过桥接观察器。当前Hark审查环境显示官方集成未安装；不据此推断其他机器的安装状态。

### 历史失败与新任务准入

2026-11-01修复原生会话保留failed终态导致新任务附着即阻塞的问题。原生outcome描述最近一次执行，不能单独归因到当前桥接任务。任务为round=0、submission为空且没有submitted历史、准入文件或基线时，经两次核验原生无active、审批和表单，将failed记录为previous_execution_failed及可准入idle；不清空原生失败，也不将任务标为完成。

每次准入前核对Herdr身份、任务租约、同原生会话占用及真实原生状态。准备阶段再次核验，保存绑定task、round、session、目录、Pane、terminal的opencodeSubmissionBaseline。准备失败保留原轮次及待发任务书；round 0的普通resume不提前写成running。已经有发送记录、准入文件或不确定提交的任务不能套用首次未提交规则。

本轮发送后，原生failed及可靠idle时间与准入基线完全相同的快照仍属于历史，不发布当前轮完成或活动回执，也不能凭此确认不确定提交。新的失败时间、缺失时间或绑定不符仍报execution_failed；活动工作、审批、表单、API异常和身份冲突继续阻止准入。此规则依赖原生idle时间区分执行，时间缺失时保守阻塞，不猜测本轮成功。

业务恢复使用原状态根的`resume <任务ID>`，不使用force、rework或重新dispatch。适用于blocked/failed且round=0、任务书尚未发送的现场；提交状态不确定时先对账，不能重投。维护端仅交付代码，真实恢复由业务主控独立执行。

主控CLI和OC共享服务无需重启。已运行的旧Pane观察器不会因源码更新自动重载；普通resume也不会替换存活观察器。为避免旧代码继续投射历史failed，业务主控须核实原生无active、审批和表单、无在途提交，核对原session、Pane、terminal及租约后，仅关闭该任务执行Pane，再执行普通resume。协调器按登记的原生ID重建本地Pane/观察器并提交原待发任务书，不新建原生会话，不关闭主控或共享服务。若无法确认空闲及归属，保持现场并报告，不关闭或重启。

## 验证边界

YDOT-OC-FAILED-ADMISSION-20261101-F1：新增15项准入回归，连同既有OC、取消及生命周期用例共51/51通过；全量191项中190通过、1跳过，既有验收8/8通过。跳过仍为已取消接入的Windows Tunnel客户端doctor。隔离环境实际运行CLI resume及opencode-worker入口，所有原生/Herdr传输、TUI和watcher启动均由明确替身提供；验证原ID单次准入、旧失败隔离、新失败上报、审批/活动/身份/租约拒绝、准备竞态回滚、丢失回执不重发。修改前源码在相同fixture中复现误报，修改后通过。未连接或恢复真实业务任务，不能据此宣称业务已启动。

2026-11-01取消确认修复：取消模块13项、既有OC14项定向测试全部通过；全量176项中175通过、1跳过，既有端到端验收8/8通过。跳过项为用户已取消接入并归档的官方Windows Tunnel客户端doctor。新增隔离CLI验收以临时状态和原生API替身验证真实cancel/recover命令：Herdr入口不可用时仍能收口原生已空闲的任务，且没有interrupt、prompt或create调用。覆盖旧cancel_pending、失败终态、双快照变化、审批/表单、API故障、身份/租约冲突、丢失回执、重复请求及并发绑定变化；不等同于真实业务任务恢复，本轮未操作业务状态或原生会话。

真实文件任务、同会话返工、关闭Pane后的原ID恢复、差量记忆、原生read/edit单次审批、批准后立即resume及运行中断已通过。95项自动回归、8项既有交付验收通过，公开证据见[evidence](../evidence/2026-10-28-opencode/README.md)。模型variant的设置与回读已验证，未另做指定variant的生成测试。整机重启、长期无人值守、真实额度耗尽、全部表单分支及外部后台命令撤销未全面验证；新版Codex空闲自动唤醒的既有验证缺口继续保留。

Hark-OC adapter整改定向验证使用临时状态根与OpenCode/Herdr替身：Pane-less中断授权、当前回合指纹、租约/同session属主、审批/表单和外来输入拒绝、session Inbox/消息ID准入对账、失败attempt稳定ID、lost-ack阻断换号、单次API读取失败去抖及API启动故障下继续启动TUI。此隔离验证不连接业务服务，不替代公共CLI集成回归或真实业务恢复验证。
