# Hark 整改分项：ZCode（ZC-01～ZC-14）

## 范围与证据

本分项对应《Hark审核报告-2026-11-04.md》附录D的ZC-01至ZC-14。原报告及`repro/ZC01～ZC05`复现材料保持原样。本次修改覆盖ZCode worker、观察、准入、取消、接管、Relay租约及ZCode专用回归；全局门禁、CLI恢复事务和跨执行端共享逻辑由主控集成。

验证只使用隔离状态目录、文件传输替身和本地进程。ZCode定向测试组共97项，97通过、0失败、0跳过；未提交真实ZCode命令，未连接真实Desktop Relay，也未改变真实Pane、服务或业务状态。测试结果证明代码路径和替身契约，不替代真实Desktop版本、RPC时序及进程恢复验证。

## 分项结论

| 编号 | Hark问题 | 整改结论与证据 | 限制 |
|---|---|---|---|
| ZC-01 | 无当前轮journal或round 0无native session时，`cancel_pending`无法收口 | round 0仅在createSession缺失或仍处于prepared且本地worker/watcher退出、未产生native session的证据成立时确认未提交；无journal但无法证明未提交时走显式abandon。abandon记录原因、证据和操作者，结束协调但保留资源隔离。`hark-zcode-cancellation.test.js`覆盖未启动证明与abandon只读评估。 | round 0的`createSession`若处于sending或ACK未知，不能推断未创建；仍需查询原commandId或保留隔离。 |
| ZC-02 | `stop_unconfirmed`空投影覆盖持久化拒绝证据 | 取消对账优先按准确task/round/session/command及持久化准入回执核验。空commandId的停止投影不取代旧命令的权威拒绝或终态；失败准入在本地执行端关闭且其他绑定核验通过时可离线收口。`hark-zcode-cancellation.test.js`及`zcode-terminal-cancellation.test.js`覆盖该投影和持久化拒绝。 | 投影与命令身份不一致或当前命令证据缺失时继续拒绝，不放宽成按状态名确认。 |
| ZC-03 | `sendText`准入unknown没有正式出口 | unknown保持同一command及原session，resume/adopt不重投，不生成替代命令。经本地worker/watcher退出及身份检查后，可用需reason/evidence/operator的abandon结束协调；task保留`originalExecutionMayContinue=true`并保留冲突资源fence。`hark-zcode-cancellation.test.js`验证unknown评估与abandon不伪造native终态；`zcode-adoption.test.js`验证接管不重放。 | unknown不能证明命令未到达；abandon只解除协调状态，不允许同会话、terminal、Relay或重叠写范围接续未知工作。 |
| ZC-04 | Herdr重启后Pane ID可能被新terminal复用 | 身份判断同时核对Pane、terminal及官方agent/native-session引用。相同Pane ID但terminal已变且无原agent/session时不能当作原执行器；正式Pane迁移则要求原native session、原terminal、command journal、worker进程出生时间、租约及新generation一致。`zcode-terminal-cancellation.test.js`和`hark-zcode-rebinding.test.js`覆盖ID重用、正式迁移和terminal替换。 | Pane不存在本身不证明原生执行已停止；terminal变化的旧worker只本地detach，不发送远端stop。 |
| ZC-05 | 旧PID文件/reaper残留可能永久占用Relay | 新租约以当前Node进程持有的Windows named-pipe/Linux abstract-UDS内核锁串行同一绑定；进程退出或崩溃由内核释放，不用PID文件判定新锁所有者。启动时仍检查旧版`<hash>.lock/owner.json`：确认存活则拒绝；确认退出则保留旧材料、不阻塞；缺失、损坏或状态不明则返回`LEGACY_REVIEW_REQUIRED`。`zcode-relay-lease.test.js`6/6覆盖竞争、旧活owner、旧死owner、残留reap、异常owner、崩溃释放及联网前拒绝。 | 旧格式只有PID，无法排除PID复用；旧owner存活状态不明时必须人工核实。不同检出路径的锁命名空间不自动相同，自定义锁根须一致。 |
| ZC-06 | session级stop可能中断外来工作，且没有原子命令条件 | 自动取消不调用V4 session-wide stop。worker仅接受准确任务状态并做只读对账；V4接口没有可绑定sourceCommandId/turn的条件stop或原子版本校验，不能证明“空快照后绝不会stop新人工工作”。`hark-zcode-cancellation.test.js`确认自动取消不发native stop；`zcode-terminal-cancellation.test.js`覆盖不确定、外来活动和精确终态判据。 | 原生命令级自动取消未实现。需要人工执行原生停止时，由操作者显式操作并重新核验；abandon只结束协调并保留隔离，不假称native cancelled。 |
| ZC-07 | 全局串行门禁放大单个ZCode故障 | 主控把冲突限制在相同native session、Pane/terminal、Relay绑定及重叠写范围；独立项目和非冲突资源可继续。未知执行的abandon仍保留相应资源fence，不通过手改cancelled/accepted释放。`hark-core-safety.test.js`及`hark-coordinator-recovery.test.js`覆盖资源隔离；主控全量回归另行记录。 | 共享同一Relay绑定时仍需互斥；隔离判断依赖保存的绑定和allowedWritePaths准确。 |
| ZC-08 | 离线取消只覆盖少量失败码和终态分支 | 未启动、明确拒绝准入、原生终态分别使用各自证据源并统一核对task/round/session/command、进程、watcher、Pane与租约。`stop_unconfirmed`不能作为终态；unknown不进入任一确定收口分支。`hark-zcode-cancellation.test.js`和`zcode-terminal-cancellation.test.js`覆盖拒绝、失败、中断、成功、unknown及身份变化。 | 没有精确权威证据时保持blocked或abandoned；abandoned仍隔离资源。 |
| ZC-09 | accepted命令启动慢时过早unknown且重复扫描历史 | accepted/duplicate首次不可见采用有界120秒快照宽限，不在此阶段分页历史；宽限结束前做一次有界历史核查。曾见过header后，若其离开尾窗且活动记录消失，改查权威历史；不以旧缓存、文件或idle推断终态。`zcode-observation.test.js`覆盖首次宽限无历史调用、header离开尾窗后历史恢复终态及最终unknown。 | Desktop长时间延迟超过宽限且权威历史仍不可见时，状态继续unknown，不自动重派。 |
| ZC-10 | adopt可能错误归属旧command或重试缺少幂等约束 | 已有命令接管核对同一session、相邻round、历史command唯一性、来源文件摘要、task lease、原native终态、外来活动和交付路径；完全相同的重复adopt幂等，不重复sendText。adopt-restored只重绑定本地观察。`zcode-adoption.test.js`覆盖重复接管、历史command冲突和身份失败。 | 控制行丢失或附着回执未确认时须重新resume/observe核实，不重投native正文。 |
| ZC-11 | resume/adopt可能先存running、控制忙worker或死worker后无watcher | 主控恢复命令在保存新running状态前核对worker、Pane、terminal、租约和进程启动身份；ZCode resume先ctrl+u再发`:resume`。新Pane认领要求同session/terminal及原观察器精确回执；更新task binding前的短暂Pane身份交接只暂停回执写入，待正式binding发布后沿用原观察循环。首次wrapper登记还会拒绝任何其他存活PID拥有的旧receipt，即使旧状态标为idle。`hark-zcode-rebinding.test.js`与`zcode-readiness.test.js`验证首次登记、handoff和CLI rework握手；恢复CLI回归归主控测试组。 | 无法证明local wrapper PID/start time或native owner时拒绝附着；新terminal必须由安全wrapper重载，不能让旧worker跟随。 |
| ZC-12 | 异步错误报告自身失败时可能产生未处理拒绝 | worker错误报告和异步清理均加捕获；task/identity变化时旧观察器只detach本地连接，不写旧回执，也不stop远端执行。原因和脱敏诊断留在任务状态。`zcode-errors.test.js`、`zcode-worker.test.js`及terminal替换回归验证错误收口。 | worker在不能证明当前binding时可能不更新任务回执；由主控显式恢复/abandon完成协调处理。 |
| ZC-13 | Pane输入残留会与`:resume`/readiness行拼接 | ZCode业务提示走`zcode-prompt.js`专用安全wrapper：核对idle receipt、Pane/terminal/session、lease和Herdr进程信息；调用Windows进程证明核对PID及出生时间，ctrl+u清行后再次复核，再以`pane run`提交本地prompt文件。lost acknowledgement保持不确定不重发。readiness/control行采用同样的清行约束。`hark-zcode-prompt.test.js`和`zcode-readiness.test.js`验证双重进程核验、原子提交、残留清行与不重试。 | 测试替换只模拟OS进程证明结果，其余Pane、session、lease和worker guard仍执行；未对真实Herdr Pane执行输入。 |
| ZC-14 | approve-once未绑定任务/轮次/命令且缺任务锁 | `zcode-control approve-once`校验请求、审批ID、interaction sourceCommandId与当前round journal、任务状态及native session，并在任务锁内执行；旧轮、外来请求、缺sourceCommandId或任务已终态均拒绝。`hark-zcode-control.test.js`覆盖单次授权、并发轮次变化和错误owner。 | 不扩大Desktop全局权限；只批准当前任务命令有证据绑定的一次交互。 |

## 验证命令与未验证范围

2026-11-04运行的ZCode隔离测试命令：

```powershell
node --test agent-bridge/test/hark-zcode-cancellation.test.js agent-bridge/test/hark-zcode-control.test.js agent-bridge/test/hark-zcode-prompt.test.js agent-bridge/test/hark-zcode-rebinding.test.js agent-bridge/test/zcode-adoption.test.js agent-bridge/test/zcode-cancellation.test.js agent-bridge/test/zcode-errors.test.js agent-bridge/test/zcode-observation.test.js agent-bridge/test/zcode-readiness.test.js agent-bridge/test/zcode-relay-lease.test.js agent-bridge/test/zcode-remote.test.js agent-bridge/test/zcode-terminal-cancellation.test.js agent-bridge/test/zcode-worker.test.js
```

结果：97 tests、97 pass、0 fail、0 skipped。全量根回归与报告总表以主控最终记录为准。本轮真实ZCode命令数为0，真实Relay连接数为0；先前记录的r2现场命令属于既有授权核验，不是本轮新增提交。未验证真实Desktop升级/重启、真实Relay KICKED及配额长延迟；V4无条件stop限制仍存在。旧版Relay租约若PID状态无法核实须人工处理，不能自动删除。
