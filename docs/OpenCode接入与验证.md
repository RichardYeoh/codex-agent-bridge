# OpenCode接入与验证

## 接入方式

执行端名称为`opencode`。当前适配OpenCode V2 2.2.0，保留Herdr Pane中的原生TUI、工具过程、审批和人工接管。Node启动器只负责CLI生命周期和状态核对；模型执行由OpenCode原生后台服务承担。无需浏览器、ACP、认证复制或全局配置改写，也不安装项目插件。

官方入口为V2 `opencode api`。创建与读取会话使用`session.create/get`，启动TUI使用`--session <真实ID>`；提交使用`session.prompt`，请求中断使用`session.interrupt`。原生TUI连接同一共享服务并显示同一会话，提交不依赖界面焦点。恢复只观察原执行，不重放原任务。关闭Pane不代表服务内任务已经结束。

稳定规则通过`experimental.session.instructions.entry.put`写入`codex-agent-bridge`键；内容未变时不重复写入。该接口保留规则并支持压缩后的上下文，但不是操作系统沙箱。每轮继续使用既有task-spec-v1、完整/差量提示、租约、任务轮次、通知和独立验收。接口属于上游实验API，升级后必须复验，V1不在当前支持范围内。

官方依据：[V2 CLI与共享服务](https://opencode.ai/v2/docs/cli/)、[V2 API](https://opencode.ai/v2/docs/api)、[会话指令接口](https://opencode.ai/v2/docs/build/plugins/server/#sessions)。核验版本为[v2.2.0](https://github.com/anomalyco/opencode/tree/v2.2.0)，提交1097e2668b1e08ad63bdf0b1c4860b9bc01e420c。V1的`/session`、插件格式及命令参数不能直接用于本实现。

## 使用与配置

昵称为`oc`，面板显示oc，多实例为oc-2等；`--agent oc`与`--agent opencode`等价，sessions查询也接受两者。内部持久类型仍为opencode，既有会话与绑定无需迁移。

```powershell
node $bridge sessions --cwd <业务目录> --agent opencode
node $bridge dispatch --agent opencode --session <Herdr服务> --pane <Codex主Pane> `
  --cwd <业务目录> --codex-thread <Codex线程> --spec-file <任务规格JSON>
```

首次登录与模型配置由OpenCode自身管理。缺省沿用其原生配置；可指定`--model provider/model`和`--effort <variant>`，或使用`provider/model#variant`。适配器根据当前模型目录核对variant，不能把所有模型的最高档都写成max。仅设置目标执行会话，不更改全局默认。Windows默认定位APPDATA/npm/node_modules/@opencode/cli/bin/opencode.exe；其他安装位置通过AGENT_BRIDGE_OPENCODE指定实际可执行文件。

默认skipPermissions写入该执行会话的allow规则。需要保留原生审批时传`--no-skip-permissions --permission-mode native`；需要逐项审批时选择`ask`。旧公共默认值acceptEdits在该适配器中兼容为继承原生策略，不表示自动批准编辑。权限规则仅作用于桥接创建的执行会话，工作范围仍由任务规格限定。

审批处理必须先核对任务、session、requestID、动作和资源范围。读取与答复均可通过CLI完成：

```powershell
opencode api session.permission.list --param sessionID=<workerSessionId>
opencode api session.permission.reply --param sessionID=<workerSessionId> `
  --param requestID=<已核实requestID> --data '{"decision":"once"}'
node $bridge resume <任务ID>
```

只批准用户已授权的具体动作，优先once；超出授权时由用户决定。表单问题须单独读取对应session.form接口，不能当作权限自动批准。人工接管使用任务保存的Pane或`opencode --session <workerSessionId> <cwd>`；同一会话避免并行写入。接管期间不要把桥接Pane切换到无关会话。

## 状态与恢复

状态来自真实会话、active集合、待审批请求和表单。失败映射为blocked/execution_failed，API不可用映射为blocked/api_unavailable，不凭窗口空闲宣布成功。窗口与API断开时原任务可能仍执行，保留原会话、轮次和现场，不自动换模型或重发。

观察器以程序核对快照，活跃时约1秒间隔、其他未闭合状态约3秒；每次还包含CLI/API耗时。状态未变化不重复上报，验收或取消后仅检查本地租约，不继续API轮询。此方法不产生模型轮次，但存在本地CLI进程和API开销。当前CLI的api事件订阅未得到可用流式输出，因此未将该入口当作可靠事件源；后续有必要时可改为官方流式客户端。

派工返回只确认准入和启动；交付后由公共watcher进入review_pending并通知主控。回执包含当前任务、轮次、Pane、Herdr服务和原生session。旧轮空闲快照不能结束新提交轮次。任务提交使用稳定准入ID；结果不确定时保持submission_unknown，禁止盲目重试。

`cancel`调用原生session.interrupt，再核对实际停止状态；确认失败时保留cancel_pending。中断不撤销已有文件修改。Pane丢失后先恢复原生会话及观测，再决定是否继续或取消。服务重启后的原生会话数据必须保留。

## 验证边界

真实文件任务、同会话返工、关闭Pane后的原ID恢复、差量记忆、原生read/edit单次审批、批准后立即resume及运行中断已通过。95项自动回归、8项既有交付验收通过，公开证据见[evidence](../evidence/2026-10-28-opencode/README.md)。模型variant的设置与回读已验证，未另做指定variant的生成测试。整机重启、长期无人值守、真实额度耗尽、全部表单分支及外部后台命令撤销未全面验证；新版Codex空闲自动唤醒的既有验证缺口继续保留。
