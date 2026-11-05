# OpenCode V2

用户昵称为oc；自然语言“交给oc”和“交给OpenCode”指同一执行端。命令支持--agent oc，原--agent opencode继续有效；sessions查询同样支持两种名称。注册名为oc，多实例为oc-2等；Codex按主Skill把Pane标题设置为“注册名 · 用途”。内部agent类型和已保存上下文仍为opencode，不因昵称重建会话。

使用`dispatch --agent opencode`。本实现核验OpenCode 2.2.0，采用官方CLI API和原生TUI，不使用ACP、浏览器或V1接口。默认可执行文件位于APPDATA/npm/node_modules/@opencode/cli/bin/opencode.exe，其他位置用AGENT_BRIDGE_OPENCODE覆盖。沿用现有登录，禁止提取认证材料。

项目、worker-key和上下文选择遵循主Skill。按真实sessionID恢复；Pane关闭不等于后台任务停止。恢复时只观察原执行，不自动重发。任务文本经官方session.prompt进入同一原生会话，TUI显示相同对话；不要在受管理Pane中切换到其他会话。

稳定规则存入官方会话指令键，未变化时不重复写入，可跨压缩保留。每轮完整或差量任务书仍由协调器生成；没有自动检测全部压缩边界的保证，已知上下文不完整时传--full-context。

未指定模型时继承OpenCode配置。显式参数为--model provider/model、--effort variant，或provider/model#variant；适配器核对已安装模型目录中的variant，不假设max普遍有效。适配器不自行判断质量或切换模型，Codex按下述用户预授权规则决定质量升级，不修改全局配置。

## 交付质量升级

仅针对外包给oc的任务：Codex独立审查发现交付明显低质，或同一任务连续两次真实交付未达到正式要求时，下一轮返工把当前会话的执行模型切换为GLM-5.3完整版，不能用GLM-5.3-Flash代替。明显低质包括偏离核心要求、关键实现错误、应有验证缺失或报告与真实文件不符，需记录具体证据；不把纯风格偏好当作严重质量问题。

每轮验收结论及证据由Codex写入任务状态目录round-NNN-review.md，注明当轮模型、问题和连续未通过次数。只计已经交付并完成独立验收的轮次，不按task.round数字推算次数。网络中断、配额耗尽、模型繁忙、审批等待或未确认提交不计为质量失败；输入或需求有问题时先澄清，不用切模型掩盖任务书缺陷。

切换前核对原生session与当前Provider，查询model.list，选择同一Provider中的精确GLM-5.3，不擅自换到其他付费Provider。2026-10-29本机默认为magpie/raccoon/sn-deepseek-v4-1-flash-1017，同Provider目标为magpie/raccoon/sn-glm-5-3；这些是核验结果，执行时仍以当前目录为准。目标不可用时保留现场并报告，不能假装已经升级。

使用协调器rework更新执行模型，避免只在原生端切换后被旧task.model覆盖：

```powershell
node $bridge rework <任务ID> --model <已核实的Provider/GLM-5.3模型ID> --prompt-file <具体返工要求>
```

该参数当前只支持oc。协调器先保存目标模型，再按原workerSessionId配置原生会话；不新建任务、会话或改变worker-key。切换模型时若不指定effort，清除旧模型的effort绑定，采用目标模型的默认variant；需要显式强度时先查目标模型目录再传--effort。切换后读取session.get确认模型再依靠原任务的状态和通知验收，后续同任务返工保持GLM-5.3，不每轮切回DeepSeek。

返工仍提供具体缺陷、应保留内容和原验收命令；保持同会话上下文，不能让新模型直接相信旧报告。原生执行未结束、审批未解决或提交不确定时先处理现场，禁止用换模重派绕过。已经使用GLM-5.3仍不达标时由Codex分析或接管，不循环换模或无上限重派。新建独立会话仍继承OpenCode原默认；相关会话后续任务按既有模型继承策略处理。用户后续明确锁定模型或禁止切换时服从该具体要求。

默认跳过审批映射为会话allow规则。保留原生权限使用--no-skip-permissions --permission-mode native，逐项询问使用ask。公共默认acceptEdits在此兼容为native，不声称自动批准编辑。cwd和提示词不是沙箱。

blocked时先读当前Pane及原生待审批：

```powershell
opencode api session.permission.list --param sessionID=<任务记录中的workerSessionId>
```

核对动作、资源、requestID及用户授权后，通过session.permission.reply指定对应sessionID、requestID及JSON正文decision=once。禁止无条件批准全部请求，禁止用always替代单次授权。用户问题/表单须另行处理。批准后resume原轮监听，不新建会话或重发任务。

cancel使用官方session.interrupt，并核对停止；无法确认时保持cancel_pending。API不可用或执行失败分别为api_unavailable和execution_failed，查看原生界面具体原因；网络、配额墙和内部重试不触发协调器自动重派。观察器做程序快照核对，不消耗模型轮次，验收/取消后停止API轮询。

适配器不写全局或项目配置。需要维护时读取工程docs/OpenCode接入与验证.md，核心为lib/opencode.js及bin/opencode-worker.js。上游API包含experimental会话指令，升级OpenCode后复验。
