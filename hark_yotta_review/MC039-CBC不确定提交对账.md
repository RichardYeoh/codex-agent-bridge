# MC039 CBC 不确定提交与终态对账

## 当前结论

工具修复、隔离验证及真实R1本地证据只读核实完成；未执行业务recover或其他状态变更。Sol负责重新冻结后自行调用正式命令、主审及R2派单。真实业务恢复仍NOT_EXECUTED，不能把隔离CLI结果当作已恢复。

## 原因与修复

pane.run被调用后，传输异常/空响应/明确负响应均可能得到CBC_PROMPT_OUTCOME_UNKNOWN。旧代码抛错时只保存本地inputAccepted=false，丢失底层诊断，且跳过watcher启动；CBC的recover没有消费原生执行证据。false仅表示本地未取得确认，不能推断未写入。

新增lib/cbc-reconciliation.js并扩展正式reconcile-submission/recover。证据必须交叉成立：

- 唯一原task/round/attempt，原始prompt文件SHA匹配持久化attempt；同轮其他不确定尝试拒绝。
- 官方CBC项目会话目录中的精确native JSONL，type=message/role=user记录的会话、cwd及单一input_text逐字匹配renderSubmissionPointer；不把文件存在、idle或工具Hook单独当成正文接纳证明。
- 同task/round/native/Pane/terminal、identityBound原生UserPromptSubmit及后续执行证据；以原输入之后首个精确Stop认定原回合结束。原生后续输入在该Stop之前则拒绝，不把新回合Stop倒配旧任务。
- 当前lease/所有者、Herdr Pane和agent身份清单、状态/审批、实际CBC Node脚本/PID及出生时间双次核验；任务、证据或进程变化时不覆盖新状态。
- 指定报告非空、路径绑定本轮、mtime不晚于原Stop，保存报告SHA。Stop仅证明原生回合终结，不证明技术通过或脱离后台作业已终止。

活动的精确原任务只附着本地watcher；审批为blocked；Stop后有报告进入review_pending，无报告为delivery_missing。原attempt journal保持uncertain历史不改写，另存round-NNN-cbc-reconciliation-ATTEMPT.json及task.submission对账引用；不伪造原传输成功或accepted。

若原回合Stop后出现其他原生用户输入，记录contextInvalidatedAt；当前会话忙碌/审批时拒绝终态收口，不中断新活动。核实其空闲后才可对账原回合，后续重新传完整上下文，不把后来的问答当作原任务完成证据。

新增诊断只保存枚举化phase/outcome/code/exitCode，不透传原始stderr、argv或提示正文。新uncertain journal明确inputWritten=unknown、transportAcknowledged；本次旧错误已丢失的细节不能凭后来执行成功反推。

## 正式命令

由Sol设置原AGENT_BRIDGE_STATE_DIR并在重新冻结后执行，先只读核对：

```powershell
node $bridge reconcile-submission <task-id> --cbc-transcript <原native.jsonl绝对路径>
```

预期state=executed、phase=stopped、原prompt指纹与报告SHA一致；此命令不改task或接触终端。原native路径已保存在维护私有证据readonly-real-proof.json中，不在公开文档写入真实身份。

需要正式记账时，再由Sol决定：

```powershell
node $bridge recover <task-id> --cbc-transcript <同一原native.jsonl绝对路径>
```

recover只做原生只读查询和本地协调记账，不发送任何正文/控制键，不重启worker，不关闭Pane。顶层recover即使返回退出0，也须检查结果数组是否包含error及落盘task状态；不能只看退出码。预期本R1有报告时为review_pending、submission observed、原attempt仍uncertain；再由Sol独立rework更新R2规格，绝不技术accept本R1。当前若又有新活动/审批/证据变化，拒绝并保留unknown，不能force绕过。

## 已执行证据

- 全量npm test：422项，421通过、1历史跳过、0失败；该跳过仍是归档Tunnel doctor。
- 相关专项38/38；包含真实CLI隔离reconcile/recover、不确定attempt原字节保留、活动/审批/缺交付区分、后续问答不能替代原Stop、foreign输入/旧Hook/提示篡改/租约/进程/并发任务变化拒绝、回执错误分类脱敏。
- 真实R1本地只读proof：原生用户输入与指针逐字一致；原Stop与指定报告SHA=4c2fb7161f22160262c3c4cebd4d35e6a8d2f3dc823182f3d27a9c0b43ba7ba3匹配；task字节不变。观察到后来“任务完成了吗”用户问答，历史终态与当前活动分开处理。
- 未对真实Pane进行任何查询/输入或执行业务恢复；本地proof和前后指纹位于.local/mc039-native-reconciliation-20261104，专项/全量日志位于.local/hark-remediation-20261104/mc039-reconcile-*.log。
- 当前源码清单140项，新增对账模块及回归。旧138清单保留在复审源码清单-MC039字段兼容.json；最新摘要以复审源码清单.json为准。未commit/push，保留其他未提交维护工作。


## 后续事实补充：CLI退出0且stdout为空

Sol在用户授权的独立手工R2中实测pane.run退出0、stdout为空，且原生确已开始工作。该模式会触发原适配器将null误判为未知的分支；由于R1历史没有原始底层诊断，不能反推其唯一原因。

工具层现在通过includeTransportReceipt显式保留CLI成功退出码和响应值，不改变既有只读API返回格式。CBC只在具有明确exitCode=0的有效结构化CLI回执时接受空stdout，回执仍为text_queued/nativeAcceptanceConfirmed=false；裸null、缺字段、非零退出、超时、明确负响应保持unknown、不自动重发。新增测试用真实隔离CLI子进程验证，不调用真实Herdr。

当前手工R2拥有独立request_id与输出目录，旧r1 Hook标签不能证明其属于旧正式payload。维护没有查控业务Pane、读写业务task或发指令；不要求恢复旧协调状态，也不要求改变不包含桥接源码的本轮35项业务冻结。用户已决定直接CBC协作时，由Sol按该授权接收、返工和验收，不因桥接占位要求暂停或切回协调器。后续若明确重新使用协调器，再核对其新版来源。

最新工具来源清单141项；旧140版另存复审源码清单-MC039终态对账.json。最终本轮回归数字与摘要以进度台账顶部和当前清单为准。
