# ZCode长任务观察与人工命令接管

## 适用范围

2026-10-31维护增量，基于0.5.0，尚未提交发布。适用于Desktop Relay/RPC执行端，不改变模型、Provider、登录配置、业务验收权或其他执行端的默认等待规则。

## 观察与收口

`waitTimeoutMs`对ZCode表示单次观察窗口，缺省30分钟。窗口到期后在同一连接续订快照，继续观察原session/command；不产生模型请求，不重新发送任务。传输异常先释放旧连接再指数退避重连，最多5次，延迟上限30秒。KICKED、认证拒绝或明确参数错误不循环抢席位。

`activeWorks.sourceCommandId`精确匹配时只确认运行。尾窗缺少turnHeader且活动记录消失时，通过官方内部只读`conversationRowsRangeV4`补取轮次头，核对commandId、logEpoch及水位。默认每页200行、最多50页；已保存轮次头行号时先定位该行，仍读取新鲜状态，不将旧的运行缓存推断为完成。无法证明终态时保留不确定，不重派。

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

先设置原状态根，在正确线程核对当前任务、轮次和通知key。普通`resume <task>`只恢复原命令观察，不重新发送业务正文。恢复先保存running及观察请求时间，再启动watcher等待新绑定回执，旧blocked不会在中途抛错造成running却无watcher。

若原观察器仍在执行，`:resume`仅在当前轮次和原命令完全一致时重新出具附着回执，不再建立Relay连接，避免本地watcher恢复后被旧时间戳阻挡。

createSession/sendText回执丢失时，程序查询落盘的原commandId，并在创建期登记查询返回的原sessionId。查询结果未知时不发送第二份写入，不另建会话规避。网络错误使用有界恢复，登录失效、席位冲突或预算耗尽仍需主控处理。

升级已运行的旧worker需要加载新代码。仅在核对Pane/terminal、Herdr shell PID、子进程路径及归属后重载桥接Node进程，保持原生session及命令日志；这不等于向Desktop发送stop。不得结束Desktop、仿真进程、整个Workspace或共享服务。运行中已取得核心修复的worker不为次要维护强行重启，后续空闲时加载最新代码。

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

## 验证边界

### Relay占用与恢复状态机补充（2026-10-31）

统一Relay租约由`lib/zcode-relay-lease.js`提供，按远控绑定摘要区分，同一检出目录的worker、zcode-control与adopt共享，跨业务状态根互斥。竞争者在认证/网络连接之前返回relay_local_busy，不踢出正在观察的进程。租约只保存PID、随机令牌和创建时间，不保存链接或认证。进程结束可回收失效租约；身份不明时保持拒绝。多份独立检出需显式共用AGENT_BRIDGE_ZCODE_LEASE_DIR，不能声称已跨所有安装自动互斥。

本地租约无法约束外部网页/手机远控客户端。KICKED保留原始错误并明确映射relay_kicked；RPC销毁不能掩盖KICKED，从而误触发自动重连。发生席位冲突立即脱离，不循环争抢；先释放其他远控客户端，再由主控普通resume一次。保留Desktop登录及原生业务运行。mobile-diagnostic是协议消息名，不能仅由名称认定具体物理设备。

恢复异常保留阶段、真实原因及校验路径到任务目录zcode-errors.ndjson和zcode-state.json，清除认证URL及凭据。已知会话的启动恢复失败不再退出worker，也不会由被拒绝的初始化Promise吞掉后续resume；进程保持脱离，等待显式恢复，不自动新建会话或重发正文。

维护装载可对已知session的worker追加`--defer-observe`，要求已有命令精确绑定。此模式不连接Relay，只保持本地恢复入口；业务task状态不自动变为running。后续普通resume才尝试附着，适合席位冲突尚未解决时部署修复，不以重载制造新连接。

自动测试覆盖多观察窗口、无header运行、历史分页和行号定位、原命令结束与交付有无、原生失败与审批、断线和不确定创建、旧阻塞竞态、Tab移动、重复接管及身份不符拒绝。真实现场验证了旧任务历史终态恢复到review_pending，以及同session人工新命令被登记为r2并继续working；维护未提交新模型任务或重跑业务仿真。

多窗口测试采用可控时间与协议替身，不等于额外完成数小时真实断网/配额测试。Desktop升级、整机重启、真实额度耗尽、所有内部协议组合仍需复验。队列入队不等于主控已读或已验收。当前维护源码不自动安装到用户技能目录。
