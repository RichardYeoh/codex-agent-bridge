# ZCode长任务观察与人工命令接管

## 适用范围

2026-11-04维护增量，基于0.5.0，尚未提交发布。适用于Desktop Relay/RPC执行端，不改变模型、Provider、登录配置、业务验收权或其他执行端的默认等待规则。ZCode的本地命令输入、观察接续、取消和隔离退出按本节执行。

## 观察与收口

`waitTimeoutMs`对ZCode表示单次观察窗口，缺省30分钟。窗口到期后在同一连接续订快照，继续观察原session/command；不产生模型请求，不重新发送任务。传输异常先释放旧连接再指数退避重连，最多5次，延迟上限30秒。KICKED、认证拒绝或明确参数错误不循环抢席位。

`activeWorks.sourceCommandId`精确匹配时只确认运行。accepted/duplicate回执到达后，命令首次可见前最多等待120秒；该启动宽限期间只续订快照，不反复扫描历史。宽限结束时执行一次有界历史核对，仍未找到命令则标记执行未确认，不重派。命令头一旦被观察到，后续尾窗缺少该头且活动记录消失时，通过官方只读`conversationRowsRangeV4`查询权威历史，核对commandId、logEpoch及水位。默认每页200行、最多50页；已保存轮次头行号时先定位该行，并读取新的状态，旧的运行缓存不能推断命令完成。

任务目录保存每轮命令日志及`round-NNN-zcode-observation.json`，后者绑定task、round、session、command、Pane、terminal及权威结果。watcher等待这些回执，不依赖Herdr旧的blocked/idle投影；切换Tab不改变身份。运行轮次变更或取消后，旧watcher退出。

| 原生事实 | 协调器状态 |
| --- | --- |
| 原命令仍在执行 | running，持续观察 |
| 原命令completedSuccess，指定报告存在 | review_pending，通知主控验收 |
| 原命令completedSuccess，无指定报告 | delivery_missing，不合成替代报告 |
| 原生失败、中断或审批 | blocked，保留原因 |
| 连接恢复耗尽或观察器不可用 | blocked，原执行可能继续 |
| 旧命令结束，但有其他未登记活动命令或队列 | blocked/untracked_command_active，不按旧轮关闭Pane |

报告中的验证失败不改变上述传输状态：review_pending只表示可主审，不表示技术通过。

## 常规恢复

先设置原状态根，在正确线程核对当前任务、轮次和通知key。普通`resume <task>`只恢复原命令观察，不重新发送业务正文。协调器先核对任务、轮次、Pane租约和执行进程身份，再清空本地输入行并发送`:resume`；发送失败时保留恢复前状态，不把未确认的恢复记为running。ZCode worker只从原journal观察原session/command。

若原观察器仍在执行，`:resume`仅在当前轮次和原命令完全一致时重新出具附着回执，不再建立Relay连接，避免本地watcher恢复后被旧时间戳阻挡。自动watcher发现正式绑定到同terminal和原生session的新Pane时，可在当前持锁状态下重新绑定本地观察器；核对包括原command journal、worker PID及进程启动时间、原Pane回执、Relay session及递增的observer generation。Pane刚迁移而task binding尚未发布的短暂窗口内，worker暂停回执写入并等待正式绑定；不能把临时身份不一致写入旧或新轮次。若terminal已替换，旧worker只脱离本地观察，不向远端发送stop。

createSession/sendText回执丢失时，程序查询落盘的原commandId，并在创建期登记查询返回的原sessionId。查询结果未知时不发送第二份写入，不另建会话规避。网络错误使用有界恢复，登录失效、席位冲突或预算耗尽仍需主控处理。

升级已运行的旧worker需要加载新代码。仅在核对Pane/terminal、Herdr shell PID、子进程路径及归属后重载桥接Node进程，保持原生session及命令日志；这不等于向Desktop发送stop。不得结束Desktop、仿真进程、整个Workspace或共享服务。运行中已取得核心修复的worker不为次要维护强行重启，后续空闲时加载最新代码。

新本地wrapper首次登记ZCode agent时，Pane/terminal必须与task lease精确匹配；完整Pane和agent inventory须证明该terminal及saved session没有其他owner，且旧worker进程已退出。仅在首次attach、subscribe前后的登记阶段允许agent尚未注册；首次report-agent成功后立即核实agent类型、Pane、terminal和native session，后续任何恢复都使用严格身份匹配。首次创建session还须有当前进程PID及启动时间对应的createSession ACK日志；不能以预填fixture身份代替首次启动证明。

## 已提交命令的接管

仅用于主控已在同一原生session人工提交且取得accepted/duplicate回执的情况。普通派工继续使用dispatch/rework，不用adopt创建任务。接管前确认原桥接观察器已空闲/阻塞并释放Relay，禁止另一观察器同时连接。

```powershell
$env:AGENT_BRIDGE_STATE_DIR = '<原状态根>'
$bridge = '<检出目录>/agent-bridge/bin/agent-bridge.js'
$taskRoot = Join-Path $env:AGENT_BRIDGE_STATE_DIR 'tasks/<任务ID>'
node $bridge adopt-zcode <任务ID> --round 2 `
  --command-file "$taskRoot/manual-command.json" `
  --spec-file '<已审查的task-spec-v1文件>' `
  --delivery-file "$taskRoot/deliveries/round-002-manual.md"
```

命令文件位于该任务目录，保存原始envelope及ack；交付位于该任务deliveries目录。下一轮号必须等于当前轮号加一。原生只读对账验证旧命令终态、新命令接纳及可见性，再保存下一轮命令日志、源文件哈希、规格、交付路径及接管证据。只向桥接worker发送`:resume`，不调用原生createSession、sendText或stop。原生session、原轮交付及历史不变。

重复接管相同命令不重复投递；源文件或交付路径发生变化时拒绝当成相同操作。接管写入后若控制行投递失败，检查已保存状态和worker回执，再使用普通resume恢复观察，不重发原生正文。已完成轮次的ack保留，旧队列提示由正常通知对账撤回；新轮结束产生新的待审事件。

当前V4接口提供的stop是session级操作，没有可原子核对sourceCommandId/turn的条件参数。自动cancel因此不发送V4 stop，不能据一次空队列或Pane关闭认定原生命令已停止；当前命令未有权威终态时保持不确定。需要结束协调流程时使用显式`abandon`，提交reason、evidence和operator。任务记录`coordination-abandoned`，保留`originalExecutionMayContinue=true`，不伪造native cancelled/accepted。abandon不会释放相同native session、terminal、Relay绑定或重叠写范围的隔离，需先取得新的可核验证据再解除相应资源占用。

## 验证边界

### Relay占用与恢复状态机补充（2026-10-31）

统一Relay租约由`lib/zcode-relay-lease.js`提供，按远控绑定摘要区分。worker、zcode-control和adopt在认证或网络连接前取得由当前Node进程持有的内核互斥锁；进程退出或崩溃后锁由内核释放，不依赖PID reaper。新版本仍检查旧版`<hash>.lock/owner.json`：旧owner存活时拒绝连接；已确认旧owner退出时保留旧证据但不阻塞新锁。旧owner缺失、格式异常或存活状态无法确认时返回`LEGACY_REVIEW_REQUIRED`并要求人工核实，不自动删除或接管。多份独立检出只有在使用同一系统锁命名空间时才互斥；自定义AGENT_BRIDGE_ZCODE_LEASE_DIR必须保持一致。

本地租约无法约束外部网页/手机远控客户端。KICKED保留原始错误并明确映射relay_kicked；RPC销毁不能掩盖KICKED，从而误触发自动重连。发生席位冲突立即脱离，不循环争抢；先释放其他远控客户端，再由主控普通resume一次。保留Desktop登录及原生业务运行。mobile-diagnostic是协议消息名，不能仅由名称认定具体物理设备。

恢复异常保留阶段、真实原因及校验路径到任务目录zcode-errors.ndjson和zcode-state.json，清除认证URL及凭据。已知会话的启动恢复失败不再退出worker，也不会由被拒绝的初始化Promise吞掉后续resume；进程保持脱离，等待显式恢复，不自动新建会话或重发正文。

维护装载可对已知session的worker追加`--defer-observe`，要求已有命令精确绑定。此模式不连接Relay，只保持本地恢复入口；业务task状态不自动变为running。后续普通resume才尝试附着，适合席位冲突尚未解决时部署修复，不以重载制造新连接。

自动测试覆盖多观察窗口、启动可见宽限、无header运行、历史分页和行号定位、命令离开尾窗后的权威终态、原命令结束与交付有无、原生失败与审批、断线和不确定创建、Pane/terminal迁移、旧阻塞竞态、重复接管及身份不符拒绝。2026-11-04本轮ZCode定向隔离回归通过91项，Relay内核租约回归通过6项。本轮没有提交或发送真实ZCode业务命令，也未连接真实Desktop Relay；不据此宣称完成新的现场执行验证。

多窗口测试采用可控时间与协议替身，不等于额外完成数小时真实断网/配额测试。Desktop升级、整机重启、真实额度耗尽、所有内部协议组合仍需复验。队列入队不等于主控已读或已验收。当前维护源码不自动安装到用户技能目录。
