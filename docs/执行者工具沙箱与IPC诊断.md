# 执行者工具沙箱与IPC诊断

## 已核实差异

2026-11-03对照持久线程元数据及各线程最新turn_context，独立验证执行主控为workspace-write、network_access=false、approval_policy=never；设计主控和维护线程为无工具沙箱限制。持久策略同时显示验证线程只有自身验证目录可写。创建者身份、HERDR_ENV、Windows管理员角色或Medium完整性级别相同，不能代替工具策略和实际访问令牌核验。

维护侧非管理员工具对现有Herdr default的只读命令退出0，Codex CLI/daemon均为0.166.0；原有proxy客户端连接、目标thread/read及queue/list均成功。该成功仅作为对照，不能记为独立验证工具已恢复。Herdr报文中的administrator提示不能单独证明必须提权或重启；Workspace分隔也不能直接解释底层IPC拒绝。

## 两种消息故障分别处理

原生queue的no rollout found发生在读取目标线程阶段。目标索引、未归档状态和rollout文件存在已确认，因此该错误不能归结为线程已删除。维护侧对同目标进行默认native queue和显式--remote unix://的有界测试，均退出0，入队各1条；随即通过官方queue/list核对并queue/delete仅撤回各自标记，未调用resume。该结果尚未定位独立验证环境内线程存储读取失败的完整原因。

旧桥接客户端的ECONNRESET发生在proxy连接阶段，可能尚未发出initialize，更未发出queue/add。新版客户端只输出固定诊断分类、连接阶段、proxy打开/退出状态及明确发送情况；不透传原始stderr。已发送后的断线仍记为不确定，不自动重发；发送前连接失败及明确RPC拒绝与之区分。增加了无恢复副作用的readMetadata方法。

官方协议规定，app-server默认stdio传输是JSONL，Unix控制socket使用WebSocket升级。已有app-server proxy转发控制socket字节的接法在维护侧真实通过，未因单个沙箱中的连接失败改成其他协议或新服务。版本匹配和具体读线程测试优先于猜测协议不兼容。

## 原工具上下文复测

在发生问题的原线程及原工作目录运行：

```powershell
node <维护工程>/tools/diagnose-agent-ipc.cjs `
  --target <目标维护线程UUID> `
  --output delegation/<本轮唯一诊断标记>.json
```

脚本仅读取限定的非凭据环境、SID/组与管理员角色、实际程序路径和版本，执行Herdr pane current及Codex metadata/queue-list；不启动服务、不queue/add、不resume、不派业务。输出仅允许位于调用目录中、已存在且未越界的父目录，使用独占新建，避免覆盖证据。结果含本机身份和路径，只留项目私有区域，不提交公开仓库。

应保留命令、退出码、原始错误、代理诊断阶段及线程/Pane对应关系。权限拒绝后停止该路径，不通过切换Shell、换管理员、改ACL、替换CODEX_HOME、读取认证材料或私有IPC绕过。跨线程请求应默认只入队；在原owner仍存活时，不附带resume或再拉第二个writer。入队回执不等于原工具已执行，必须收到该工具产物或明确答复才能验收。

## 权限修复边界与后续约束

客户端代码能够改进诊断和发送确认，不能授予沙箱未允许的IPC访问。当前未改Windows ACL、全局配置、验证线程策略或共享服务。仅放行指定Unix socket的权限配置有官方通用说明，但本机Windows版本与当前运行线程的最小配置兼容性尚未验证，不将其作为可直接执行的已测方案。

需要用户明确选择：保持验证沙箱并继续使用已有获准传输代理，或只调整该验证会话的工具权限。若选择完整访问，会扩大该会话工具的本机文件与网络访问，必须明确授权；不等于Windows管理员提权，也不改变业务文件的职责约束。具体切换由受支持的用户权限入口完成，不直接编辑底层线程数据库、信任记录或绕过owner。调整后须在原验证工具中再次运行同一诊断并验证原生消息路径，才能宣称恢复。

创建需要调度外部Agent的执行主控前，先核实角色所需工具权限，做只读Herdr IPC和目标消息路由预检；权限不足时先报告，不反复创建失败派工。职责边界和工具访问边界分别声明，不能假设子线程继承创建者权限。

## 验证与剩余项

客户端新增4项测试，覆盖只读RPC序列、碎片stderr诊断脱敏、关闭连接后未发送的准确回执、明确RPC拒绝和发送后不确定且不重放；全量251项中250通过、1跳过，既有验收8/8。初次专项发现退出时流错误未被接收，已补充error处理并复测通过。

独立验证只读请求已通过官方队列入队且未resume；截至维护收口时尚无原工具执行报告，不能标记真实修复完成。原生queue在该工具上下文中的存储读取故障仍待原环境验证，不把维护侧成功算作通过。证据、版本schema、策略对比及仅本次修改备份保存在.local/sol-tool-ipc-20261103，前次CBC启动前失败修复保持不变。

参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)、[Permissions](https://learn.chatgpt.com/docs/permissions)。
