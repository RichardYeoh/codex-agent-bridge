# CBC首次启动前失败的恢复

## 问题与处理边界

首次dispatch在Herdr服务检查阶段失败时，CBC原生会话、Pane及任务轮次均可能尚未建立。旧实现保留failed/round0占位，又将普通resume解释为恢复已有原生ID，同绑定新dispatch则被未闭合占位阻断。此类任务需要取消未启动的派工申请，再首次创建新的CBC会话，不存在应当恢复的旧原生ID。

新版dispatch在检查服务前保存startup边界；上下文复用或创建位置之前，先将边界标记为worker-effects-possible。恢复只认定可证明仍处于检查服务之前的任务，不能从空会话字段直接推导未启动。

## 正式操作

由业务主控使用具有现有Herdr访问权限的工具执行，状态根、项目目录、原冻结规格和worker-key保持不变：

```powershell
$env:AGENT_BRIDGE_STATE_DIR = '<原独立验证状态根>'
$bridge = '<维护工程>/agent-bridge/bin/agent-bridge.js'
node $bridge recover <失败任务ID>
node $bridge cancel <失败任务ID>
node $bridge status <失败任务ID>
```

recover仅给出证据和下一步，不自动创建会话或提交任务。cancel在证据充分时通过协调器写入cancelled，source为startup-not-started，保留round0原失败历史，记录无原生会话、无提交、无中断。重复cancel幂等。普通resume会明确提示cancel后新dispatch，不再要求不存在的原生ID；无需force。

确认cancelled后，使用新的任务ID及原始dispatch参数首次启动CBC。保持原worker-key和冻结spec-file，不传resume-task，不新建Workspace，不通过parallel绕过现有活动检查。若同状态根中另有串行执行任务，新dispatch仍会被正常阻止；本修复只释放经核实的旧占位。

## 证据约束

仅适用于CBC round0且没有会话、Pane或terminal的失败启动申请。submission、工作者启动、任务轮次文件、实际提示投递、上下文/Pane租约、执行历史或事件、存活观察器/启动进程、并发元数据变化等任何矛盾证据都拒绝释放。新版任务须有检查服务阶段的持久边界；旧版任务须同时具备精确Herdr服务检查失败、对应failed历史及dispatch_failed事件，且仅存在初始申请和标签等允许产物。其他阶段的不确定失败不适用。

正式取消操作由既有协调器全局/任务锁保护，并在落盘前再次核对任务和证据。不会修改其他任务，不会向任何终端发送输入，不会伪造accepted，也不会在恢复命令中补发任务书。

## IPC拒绝的独立诊断

现场Herdr日志记录PermissionDenied，包含提升权限服务拒绝客户端的提示；旧serverRunning吞掉异常并返回false，进而触发无用的服务启动及误导性超时。新版保留原诊断并返回HERDR_IPC_ACCESS_DENIED，首次权限拒绝即停止，不spawn服务、不等待、不修改ACL或审批模式。

维护环境只读status server返回running，当前维护进程不是管理员。该结果只能证明维护工具当前可访问既有服务，不能证明Sol工具当时的沙箱、访问令牌和IPC权限相同。未读取Sol凭据、仿冒其身份或绕过拒绝；Sol具体权限上下文仍未独立复现。业务主控应使用已有授权且可访问服务的工具；若该工具仍被拒绝，保留准确错误，不重启共享服务或擅自提升权限。

## 验证

专项覆盖旧版证据、新版副作用边界、真实CLI首次dispatch失败及cancel/recover/resume、身份/活动/提交/租约/并发冲突、保留其他运行任务和原串行门禁、IPC拒绝零spawn/零等待。传输和首次派工使用隔离替身，不连接真实CBC或执行业务任务。

真实失败申请已通过无写入proveNotStarted核验；本次维护未执行其cancel或新dispatch。测试日志及业务文件不变性摘要保存在.local/cbc-prelaunch-recovery-20261103，真实恢复由业务主控按回执决定。
