# ZCode Desktop执行端

采用Desktop官方Remote Relay V2与Host RPC传输，复用Desktop所管理的Start Plan Provider。连接、文本命令、快照和完成观察均由原生Node程序执行，日常调用无需浏览器技能。此接口源于官方内部客户端实现，尚非承诺稳定的第三方SDK；固定上游源码与Desktop版本后验证，升级必须复验。

前提：Desktop已登录且运行，官方Web远控已启用。将官方连接链接保存到私有JSON的remoteUrl字段，放在原状态根zcode-desktop.json；禁止写进公开仓库或报告。可用--zcode-config显式指定其他私有配置。共享登录凭据由官方只读函数在内存读取，仅向固定官方域名申请一次性Relay token，不复制、不打印、不持久保存解密值。

```powershell
node $bridge dispatch --agent zcode --session <服务名> --workspace <WorkspaceID> `
  --codex-thread <线程ID> --cwd <业务目录> --spec-file <任务规格JSON>
```

默认GLM-5.3-Flash、max。GLM-5.3可显式选择，繁忙时blocked，不自动降级。默认权限跳过对应yolo；--no-skip-permissions --permission-mode edit保留工具批准，可能暂停验收命令。cwd及提示词白名单均不是沙箱。

执行Pane名zcode，实际会话ID保存在workerSessionId。首次按业务目录匹配Desktop项目，不存在时通过Project服务创建项目条目；不改已有用户任务。每次任务完成或阻塞后释放Relay席位，后续重连原会话。手机、网页同时连接可能抢占同一席位；KICKED后保留任务并停止连接，不能循环争抢。

事件包含sourceCommandId。accepted只证明接收，完成须对应当前commandId的turnHeader终态。指令先落盘再发送；断网或回执丢失后只查询原命令、恢复快照，不盲目重发。普通resume可恢复监听；resume --force属于明确重投，不能用于尚未查清的提交。

权限或执行状态需要人工接管时，可先用以下命令查看原生权威状态。批准前逐项核对请求内容是否在已有授权内；approve-once不会授予项目级或完全访问权限。完成批准后resume继续观察原命令。

```powershell
node <协调器根>/bin/zcode-control.js <任务ID> snapshot
node <协调器根>/bin/zcode-control.js <任务ID> approve-once <interactionId>
node $bridge resume <任务ID>
node $bridge cancel <任务ID>
```

cancel将Escape转换成V4 stop，并等待无activeWorks；未确认则cancel_pending。模型可能存在自身网络重试，协调器不宣称可以关闭全部内部重试。Desktop退出、登录过期、远控关闭及协议升级均可能阻断连接；先恢复前提，再检查原会话。整机重启和长时间无人值守尚未全面验证。

未显式指定effort的新派工统一采用max，包括复用先前low会话时的下一次派工；会话ID保持复用，V4发送本次模型配置。显式--effort low/high仍可覆盖。已落盘的运行中任务不被批量改写。历史真实端到端测试采用low，max默认映射经程序回归核对，未额外消耗模型额度重跑完整链路。
