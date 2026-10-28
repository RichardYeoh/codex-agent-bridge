# OpenCode V2

使用`dispatch --agent opencode`。本实现核验OpenCode 2.2.0，采用官方CLI API和原生TUI，不使用ACP、浏览器或V1接口。默认可执行文件位于APPDATA/npm/node_modules/@opencode/cli/bin/opencode.exe，其他位置用AGENT_BRIDGE_OPENCODE覆盖。沿用现有登录，禁止提取认证材料。

项目、worker-key和上下文选择遵循主Skill。按真实sessionID恢复；Pane关闭不等于后台任务停止。恢复时只观察原执行，不自动重发。任务文本经官方session.prompt进入同一原生会话，TUI显示相同对话；不要在受管理Pane中切换到其他会话。

稳定规则存入官方会话指令键，未变化时不重复写入，可跨压缩保留。每轮完整或差量任务书仍由协调器生成；没有自动检测全部压缩边界的保证，已知上下文不完整时传--full-context。

未指定模型时继承OpenCode配置。显式参数为--model provider/model、--effort variant，或provider/model#variant；适配器核对已安装模型目录中的variant，不假设max普遍有效，不自动切换模型或修改全局配置。

默认跳过审批映射为会话allow规则。保留原生权限使用--no-skip-permissions --permission-mode native，逐项询问使用ask。公共默认acceptEdits在此兼容为native，不声称自动批准编辑。cwd和提示词不是沙箱。

blocked时先读当前Pane及原生待审批：

```powershell
opencode api session.permission.list --param sessionID=<任务记录中的workerSessionId>
```

核对动作、资源、requestID及用户授权后，通过session.permission.reply指定对应sessionID、requestID及JSON正文decision=once。禁止无条件批准全部请求，禁止用always替代单次授权。用户问题/表单须另行处理。批准后resume原轮监听，不新建会话或重发任务。

cancel使用官方session.interrupt，并核对停止；无法确认时保持cancel_pending。API不可用或执行失败分别为api_unavailable和execution_failed，查看原生界面具体原因；网络、配额墙和内部重试不触发协调器自动重派。观察器做程序快照核对，不消耗模型轮次，验收/取消后停止API轮询。

适配器不写全局或项目配置。需要维护时读取工程docs/OpenCode接入与验证.md，核心为lib/opencode.js及bin/opencode-worker.js。上游API包含experimental会话指令，升级OpenCode后复验。
