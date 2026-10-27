# Antigravity CLI执行端

使用官方agy原生交互界面。Herdr Pane直接运行agy，对话、工具执行和权限提示可见，可人工接管；任务轮次、通知和验收继续由协调器管理。没有额外后台服务，也不依赖桌面操作。

前提：本机agy已完成登录，agy models可列出可用模型。执行文件默认位于LOCALAPPDATA/agy/bin/agy.exe；可用AGENT_BRIDGE_AGY覆盖，Node须可通过PATH调用。禁止读取、复制或输出登录凭据。

```powershell
node $bridge dispatch --agent agy --session <服务名> --pane <Codex主PaneID> `
  --cwd <业务目录> --codex-thread <线程ID> --spec-file <任务规格JSON> `
  --model <agy模型ID> --effort low
```

启动前通过一次官方stream-json初始化取得或核验conversation_id，不发送用户提示、不触发模型任务，随后关闭该预检进程，以同一ID启动原生TUI。启动恢复只能使用明确ID，不使用--continue猜测最近会话。关闭空闲Pane后仍按保存ID恢复，核实后继续差量。

首次使用项目时，适配器在该项目.agents/hooks.json中合并codex-agent-bridge-agy条目，并生成同目录的codex-agent-bridge-agy.cjs入口，保留其他Hook；已有文件修改前备份到状态根hook-backups。条目已被人工修改时拒绝覆盖。入口脚本包含本机安装路径，两项文件均属于本机绑定，不应提交到业务仓库；不修改全局登录或权限配置。Hook仅在协调器创建的Herdr上下文中工作，普通agy调用不会因此获得额外权限。

PreInvocation将稳定规则通过官方injectSteps/systemMessage注入，同一原生会话和规则版本只注入一次；每轮规格仍包含当前要求、写入范围、验收与交付。自然语言如何选择执行者归Codex/Skill，程序校验规格与身份，不保证关键词100%触发。

模型未指定时继承CLI默认；--model与--effort透传，不自动换模型。默认skipPermissions映射--dangerously-skip-permissions，表示该CLI运行跳过常规工具审批，并非单次授权或操作系统隔离。需保留审批时传--no-skip-permissions --permission-mode accept-edits，也可选择auto、plan。

启动阶段尚未建立watcher就阻塞时，同样持久保存blocked并通知主控；没有可靠线程绑定时只落盘，不能保证自动唤醒。Codex接到启动错误后须主动读取visible提示，不等待用户提醒。

首次目录信任与工具审批是不同事项。只有该目录已获授权时才加--trust-folder；未明确允许则blocked。主控可通过Herdr读取visible文本，核对具体路径和动作后用send-keys/send-text回答，不需要鼠标或浏览器。工具审批优先原界面单次允许，不关闭会话或重发任务来代替当前审批；涉及超出授权范围的动作仍须询问用户。不得连续发送回车或自动选择永久授权。

blocked仅表示需要核查，不等于所有执行端都有统一的approve接口。原生agy还由Herdr识别UI状态；Hook补充用户交互、错误与后台任务未收敛的状态。审批处理后用resume恢复原轮观察；rework追加明确返工要求。连接、提交或停止状态不确定时禁止直接重发。

人工接管按task.json中的Herdr服务、Pane及terminal核对身份；原生CLI恢复入口为agy --conversation <workerSessionId>。不得同时让两个进程修改同一会话。cancel通过原生Escape请求中断，观察实际状态；未确认停止保留cancel_pending，不宣称已停止。中断不能撤销已完成的文件修改或远端副作用。

主控、Herdr或模型服务暂不可用时保留任务状态、会话ID和交付。网络、配额墙与限流不触发协调器自动换模型、新建会话或无限重发；CLI自身可能重试，上限与行为由上游决定。恢复后先核对现场，再恢复监听或发送明确继续要求。若原生Hook因资源错误保持blocked而原CLI已空闲，主控在核实原轮结束后可通过该原生Pane发送具体继续要求，再resume原轮观察；不能在状态不明时调用resume --force。
