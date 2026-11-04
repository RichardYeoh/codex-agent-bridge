# MC039 CBC 元数据兼容补修

## 根因及范围

真实Herdr 0.9.5自报CodeBuddy元数据省略agent_session与completion_seq，仅有state_change_seq。旧guard将可选字段当作必填，测试也一直构造了带字段的回包，导致真实首次输入前拒收。官方[AgentInfo结构](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/agents.rs)将两字段定义为Option；state_change_seq与completion_seq具有不同语义，不能互相替代。

仅维护工程源码和隔离测试发生修改。真实业务只读原task、Hook及所提供现场JSON，未访问或控制业务Pane，未resume/replay/rework/accept/cancel/关闭/新建会话、提交业务或运行EDA。原MC036终态不再处理。

## 修复

1. CBC guard接受可选字段缺失/null，但显式原生引用若冲突、损坏或指向另一Pane/terminal仍拒绝；全量Pane/Agent归属清单、命名、状态和审批检查保持。
2. 原生身份必须由identityBound Hook证明，精确匹配task/前轮、session、Pane、terminal、workerStartedAt及租约。最新terminal Hook不得来自其他session；Hook必须晚于当前CBC进程出生，避免旧Hook为新进程背书。精确Node脚本/PID/出生时间证明保持两次复核。
3. submission单独保存baselineStateChange；状态序号只证明输入前快照稳定，不作为完成序号。可选completion字段存在时仍严格核验；既有完成基线不能在字段消失后被默认0抹去。
4. 极短回合未采到working且无completion字段时，仅凭当前提交之后、同task/round/session/terminal、identityBound原生Hook确认本轮活动。旧轮Hook、SessionStart或单纯state_change_seq增长不能替代。返回仍为text_queued/nativeAcceptanceConfirmed=false，不据此宣告特定正文接纳或技术完成。
5. 添加脱敏真实回包形状fixture。CLI隔离测试覆盖正常工作、瞬时回合，以及发送前明确拒收后普通resume在同task/原session首次提交一次；首败journal不被覆盖，无新执行者或重复发送。

## 验证

- 定向30/30通过；随后完整回归包含新增真实形状fixture与活动证据反例。
- `npm test`：414项，413通过、1历史跳过、0失败，退出0；跳过仍为归档Tunnel doctor。
- `node --check`：123 JS/CJS文件通过；源码清单138文件，7项变化。旧137清单保留为复审源码清单-首次整改.json。
- 新aggregate SHA-256：`16a742764a6b2d1b6d50d840e24d6122f25a5647803eed689e176e80e3b09930`，见[当前源码清单](复审源码清单.json)。
- 完整回归日志：.local/hark-remediation-20261104/mc039-full-final.log；证明与通知回执：.local/mc039-guard-schema-20261104。

测试使用脱敏实测回包、临时状态和外部Herdr/Windows查询替身；真实业务新guarded发送仍为NOT_TESTED。没有用真实业务试发来验证，也不将模拟TUI接纳等同真实模型接纳。

## Sol接续边界

先重新冻结工具来源，读取当前failed/r0、submission为空和rejected-before-input首败journal，核实原native/Pane/terminal/lease仍一致且无活动/审批。条件仍成立时由Sol显式使用原状态根运行普通`resume <原任务ID>`，这是首次提交当前初始任务书，不是重投已接纳轮次；不用force、不新建owner、不涉及旧MC036。状态已变化时先对账，不据本说明盲发。

维护未执行上述业务resume。新协调器进程读取新源码，不需要为了加载本次修复重启原CBC、Herdr或共享服务；已存在观察器并不自动热载。无新EDA许可，技术验收仍由Sol负责。源代码保持未提交，不commit/push，Hark复审应审查当前工作树及新增文件。
