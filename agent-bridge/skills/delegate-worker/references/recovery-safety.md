# 正式恢复与资源隔离

命令以当前安装绑定的agent-bridge.js为入口，先设置原状态根。

- `recover <id>`：先对账；未知准入不重发，API失败不推断任务停止。已提交轮次的`resume`及`--force`不重投。
- `adopt-restored <id> --pane <pane>`：凭官方原生session、执行端、terminal及租约认领移动/恢复后的唯一执行者，不新建第二个TUI。
- `observe <id> --wait-timeout-ms <N>`：重新附着观察，旧观察代次失效，不发业务文本。
- `resume <id> --retry-failed`：仅OC当前轮新的明确失败、空闲且无审批/外来输入时显式重试；每轮最多2次稳定准入。lost ACK先recover，不换ID。
- `settle <id>`：指定迟到交付及原生完成证明核实后转review_pending，不代表验收通过。
- `message-retire <id> --message-id <id> --actor <主控> --reason <原因> --evidence <说明>`：仅已终结且原执行不会继续时记录人工退役，不冒充送达/未送达；活动/未知执行不允许。
- `abandon <id> --actor <主控> --reason <原因> --evidence-file <文件>`：无法确认终态且本地观察退出时结束协调，仍保留原生身份、Relay及重叠写入隔离；不是cancelled/accepted。

CBC/AGY没有经验证的命令级停止接口，活执行者不得盲发Esc或审批键；核实现场停止确切执行端后recover。ZCode SDK没有command条件stop证明，不能发送全局stop关闭他人工作。Pane关闭不能证明脱离的后台作业停止。所有未知状态均保留证据和准确限制。

通知和消息按回执强度报告：文本写入、排队、原生接纳、消费、主控ack均不同。只有取得相应原生回执才能说纠偏已生效。不自动重发状态不明的消息。

## CBC输入与旧拒收对账

Herdr named/idle不等于内置agent prompt可用。CBC走专用guarded pane.run：必须核实原生Hook空闲边界、租约、Pane/terminal、可见审批和真实Node执行进程，预检缺失则拒绝；返回text_queued不能报告模型已接纳。外部人工同时操作TUI存在跨RPC竞态，不冒充服务端原子审批检查。自定义.ps1仅是启动入口，实际原生CBC需可识别的npm shim；必要时首次dispatch显式指定--cbc-native-binary和--node-executable，不能用Shell存活代替Agent进程证明。

旧CBC的agent_not_ready为Herdr明确发送前拒收时，先运行`reconcile-submission <id> --rejection-receipt <原始完整回执JSON>`。该命令只读核对精确RPC、任务、轮次、原始历史、事件及提示摘要；not_sent只描述旧桥接请求，nativeWorkState=not_checked，不说明当前人工直发工作完成。unknown无证据时仍不能force重放。

确需结束旧协调申请，可显式`abandon <id> --rejection-receipt <同回执> --actor <主控> --reason <理由>`；它保留旧submission/history和原生ID，不操作当前执行端，隔离整个项目及原会话资源。不是释放当前业务接续的旁路。用户另行直发过的任务应由原主控核对自己的intent/receipt及验收，维护不得重投旧申请或停掉同Pane新工作。


## CBC传输回执不确定但原生已执行

`inputAccepted:false`不等于未写入。先只读`reconcile-submission <id> --cbc-transcript <原native.jsonl>`，要求官方CBC项目会话记录中精确用户指针、持久attempt/prompt摘要及绑定Hook交叉一致。需要正式记账时由主控调用`recover <id> --cbc-transcript <同文件>`；活动原回合只启动观察，精确Stop加指定交付仅进入review_pending，不代表技术通过。旧uncertain attempt保持原样，另存对账回执。原生后续输入、审批、身份或进程变化不得被旧Stop覆盖；忙碌时不强制收口。不得以此重投正文或绕过原任务书重新冻结。详细边界及命令结果检查见维护工程docs/异常恢复与资源隔离.md。
