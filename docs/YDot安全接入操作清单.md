# YDot安全接入操作清单

> 当前状态：用户已取消接入，C1本地清理完成。旧安装、密钥创建、启动和订阅步骤均为历史方案，不应执行。客户端与配置已撤出活动位置，源码和验收记录保留；恢复须另有明确要求。详见第9节。

任务标记：`YDOT-EVENT-BRIDGE-20261031-IMPL1`。本清单补充可执行的接入步骤，不代表Tunnel、凭据、插件、真实订阅或后台服务已经建立。

## 1. 已完成部分与入口

本地桥接已具备项目观察Hook、最小allowlist采集、持久缓冲、认证MCP HTTP、Events订阅及签名HTTPS callback。Stop和所有可控路径输出有效JSON对象`{}`，不含停止/权限决定；事件为`codex.stop.observed`，不直接证明最终完成。

本次已按新增普通项目配置授权合并父目录`.codex/hooks.json`，仅增加Stop、PermissionRequest、Interrupt三个异步观察Handler，已有定义保留。精确路径、备份和SHA256保存在私有目录`.local/ydot-event-bridge-20261031/hooks-applied-proof.json`。目标allowlist仍仅限已授权原owner及其原cwd，具体ID留私有config.json，不在此公开复制。

用户已正常恢复原会话并在启动阶段审阅信任三个观察Hook；官方运行清单确认全部trusted且enabled，原生Stop真实采集也已补验。首次加载时可出现启动审阅入口，已加载定义也可通过`/hooks`管理。此前旧会话Installed=0属于新增配置未进入运行清单，不应继续尝试空页面按键，也不能据此声称每次启停均须重启。不信任其他定义、不改审批、不绕过信任、不代用户关闭CLI。补验层次与证据见[YDot事件桥接实现与验证](YDot事件桥接实现与验证.md#61-2026-10-31原生stop补验)。

服务入口与将来绑定：

```powershell
node agent-bridge/bin/codex-events.js serve `
  --config .local/ydot-event-bridge-20261031/config.json --port 42589
```

以下为独立服务维护入口；本项T1已获官方客户端、专用通道及受限凭据的新增授权，常规启动改用第8节安全输入入口。服务只监听`127.0.0.1:42589/mcp`，同一认证端点提供initialize、events/list、events/subscribe、events/unsubscribe和只读bridge_status工具。缺少授权Bearer令牌时拒绝启动。认证principal固定为服务端的ydot，外部请求不能自行冒充其他principal。现有用户返回指令仍走原codex queue，不增加远程写工具。

## 2. Secure MCP Tunnel适用性与证据等级

| 判断 | 依据与边界 |
| --- | --- |
| 官方支持私有HTTP/stdio MCP经Tunnel接入ChatGPT插件 | [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)及[插件连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)明确提供Connection: Tunnel，不要求本地公网监听 |
| 官方支持Work/dot的MCP Events | [MCP Events](https://developers.openai.com/plugins/build/mcp-events)支持带events能力的Streamable HTTP初始化和webhook订阅，本桥接使用该接口 |
| 本端协议与通用Tunnel转发机制匹配 | 官方tunnel-client说明会转发带id的JSON-RPC并匹配响应，也支持通知；本端采用stateless HTTP，可作为main MCP目标 |
| Events-over-Tunnel整链路兼容 | 上述文档未找到对这一组合的专项保证。本项仅作为有官方机制依据的候选路线，未安装tunnel-client、未建立Tunnel，不能标记已兼容或真实唤醒成功 |

数据方向必须分开：

1. ChatGPT→MCP：本机tunnel-client主动向OpenAI进行HTTPS长轮询，收到的MCP请求转发到本地回环地址；响应沿同一Tunnel回传。该程序轮询协议队列，不是LLM轮询历史。
2. MCP→YDot事件：本地桥接主动向实际订阅返回的公网HTTPS callback投递Standard Webhooks签名事件；此POST仍需普通出站HTTPS和DNS，不由Tunnel自动代发，也不使用SSE替代事件回调。

因此Tunnel能避免入站公网端口，但不取消事件回调的出站网络要求。若现有网络拒绝该callback，应记录精确错误并停止，不修改防火墙、代理、证书或全局网络策略绕过。

## 3. 凭据与权限分工

| 项目 | 具体要求 | 操作者/授权边界 |
| --- | --- | --- |
| Tunnel管理 | Platform组织、目标ChatGPT工作区关联；创建/修改需Tunnels Read + Manage | 用户或组织管理员在Platform界面操作；本轮未创建 |
| Tunnel运行 | 单独受限runtime API key，目标Tunnel的Read + Use | 用户在本地安全输入或批准的秘密注入中提供；不是Codex CLI登录凭据，不使用Admin API key跑服务 |
| 本地MCP认证 | EVENT_BRIDGE_TOKEN至少32字节；Tunnel本地转发时使用对应Bearer头 | 后续需用户批准提供/生成仅本项使用的令牌，本轮未生成或读取现有令牌 |
| Callback签名 | MCP客户端订阅时提供24至64字节whsec密钥 | 来自真实ChatGPT订阅；不得手工编造生产URL/签名材料；落盘前需落实私有目录ACL和订阅授权 |
| ChatGPT插件权限 | 目标工作区允许添加和使用自定义MCP服务器，能够选择该Tunnel | 用户/工作区管理员批准，不等同于Platform Tunnel权限 |

推荐用户在[Platform Tunnel设置](https://platform.openai.com/settings/organization/tunnels)创建或选择专用Tunnel，并将它关联到YDot所在ChatGPT工作区及需要使用的Platform组织。个人账户也需使用对应个人Platform组织。仅关联Platform组织不保证在另一个ChatGPT工作区可见。

管理可全部由用户界面完成，不要求本地持有Admin API key。runtime key应限制到本项Tunnel所需权限，不能将ChatGPT/Codex登录Cookie或CLI认证文件代作该key。不要向聊天发送密钥、令牌或完整签名回调。

当前本地认证是单owner模型。若采用Tunnel转发时注入本地Bearer头，必须把Tunnel Use及插件访问限制到该授权owner/YDot；不能将同一固定principal入口直接共享给整个团队。连接界面若支持无额外OAuth的私有Tunnel模式，可在Tunnel访问控制和本地Bearer认证均保留的前提下使用；该界面组合尚未实测。若产品/组织要求OAuth，需单独授权并实现真实身份适配，不能取消本地认证或伪装成已有OAuth。

## 4. 初始前台方案与配置样例（T1实际安装见第8节）

模板：`agent-bridge/examples/codex-events/tunnel-client.example.yaml`。只包含非敏感本地地址、通道和环境变量引用，没有真实tunnel_id或凭据。键名依据官方[tunnel-client配置文档](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)；实际安装版本的help优先，不能盲用不同版本参数。

未来步骤：

1. 用户另行批准安装官方tunnel-client到指定位置；本轮未在PATH发现该命令，未下载安装。按官方发布页面核验来源，再运行`tunnel-client help quickstart`和`help samples`检查当前参数。
2. 将模板复制到本项目私有目录，命名为`.local/ydot-event-bridge-20261031/tunnel-client.yaml`。不要把秘密写入YAML。
3. 用户通过安全输入/秘密注入提供CONTROL_PLANE_API_KEY、CONTROL_PLANE_TUNNEL_ID、EVENT_BRIDGE_TOKEN。前者是受限runtime key，ID为实际已授权Tunnel。令牌不得写在命令行参数中。
4. 在获授权的同一环境中构造本地转发头：`EVENT_BRIDGE_AUTHORIZATION`的值为`Bearer `加EVENT_BRIDGE_TOKEN。这里不涉及创建OAuth，且不转发Platform API key给本地MCP。环境值不要输出或记录。
5. 经用户另批启动两个前台进程：一个运行本地桥接，另一个运行Tunnel客户端。不要安装服务、使用后台守护或runtimes connect自动建立长驻运行。

后续可执行的非敏感命令如下，**本轮均未运行doctor/run，也未提供任何真实key**：

```powershell
tunnel-client doctor --profile-file .local/ydot-event-bridge-20261031/tunnel-client.yaml --explain
tunnel-client run --profile-file .local/ydot-event-bridge-20261031/tunnel-client.yaml
```

模板中的`main`指向本地HTTP入口，排除非必要harpoon通道，并显式设置cloudflared.managed=false，不启用该额外转发进程；mcp.extra_headers和discovery_extra_headers均使用`env:EVENT_BRIDGE_AUTHORIZATION`，control_plane.api_key使用`env:CONTROL_PLANE_API_KEY`，实际Tunnel ID由CONTROL_PLANE_TUNNEL_ID注入。只监听本地42589和本地健康检查42590，不产生公网监听。

官方配置文档还明确：connector转发的请求头优先于静态extra_headers。若其Authorization与本地令牌不符，本地入口应返回401，不能关闭认证来“修通”。因此选择插件认证方式时必须核实实际转发头；当前无额外OAuth的专用私有Tunnel方案尚未在产品界面验证。要求OAuth的环境停在该边界，另行实现并授权真实身份验证。

doctor/readyz仅证明本地和Tunnel基础链路，不证明ChatGPT能订阅Events。不要用demo MCP stub代替本项目事件服务完成验收。保持两个前台进程运行才能发现和调用；终端关闭或认证过期会影响该链路。

## 5. 插件连接、订阅及真实验收

按门槛逐层推进，某层失败则保留证据并停止，不跳过：

1. 用户在ChatGPT Plugins选择Add custom MCP server，Connection选Tunnel，选择同一真实tunnel_id。确认组织/工作区关联及Read + Use权限，按组织要求配置认证，由用户本人审阅风险提示并Create as a plugin。
2. 先发现并安全调用bridge_status。它只返回当前principal的订阅状态，不能触发shell、审批或队列写入。成功只算MCP工具链路通过。
3. 刷新插件发现，确认出现codex.stop.observed、codex.permission.requested、codex.turn.interrupted三个事件。服务需实际收到events/list；如果仅工具能调用却事件未出现，记录为Events-over-Tunnel尚未通过，不假报完整兼容。
4. 用户在原YDot所在dot明确授权订阅本项target_id=codex-doc-owner。建议指令：监视本目标的三类事件，唤醒后按已有只读权限核对原会话末条答复并摘要；审批仅转交用户，Stop不代表工程完成。订阅应由ChatGPT客户端发events/subscribe，不由本地脚本伪造云端callback。
5. 确认实际callback挑战验签/echo成功、订阅持久保存且有效期明确。仅有订阅记录不足以认定YDot收到事件。
6. 用户在同一原Codex会话发一项无害的短回复要求，使其自然到达Stop。不要主动Interrupt、强制重启或故意制造危险审批。原生Hook实际采集、出站签名回调2xx、YDot实际唤醒并转回正确摘要三项分别留证；比较同一eventId/turn_id，不用定期LLM读历史冒充推送。
7. 验证相同过滤目标刷新不产生新ID、重复事件不重复执行动作、非目标不投递；停止监视后确认events/unsubscribe及后续不再新投递。对已经在途的一条HTTP事件不作强制撤回承诺。

如果这条路线不支持事件发现/订阅，不将轮询作为无提示替代。替代路线需要对一个公开HTTPS认证MCP端点单独授权部署，仍不在本轮范围内。

## 6. 停止、撤销与项目Hook回滚

1. 用户先让YDot停止监视，确认客户端对原事件名、过滤参数和callback调用events/unsubscribe。此后不再新投递，已在途请求可能完成。
2. 只停止本项tunnel-client和事件桥接前台进程；不要停止原Codex、Herdr或其他业务。桥接正常退出会释放自己的event-server-owner.json，不删其他锁。
3. 在ChatGPT断开/删除本项插件。用户在Platform停用或删除仅本项的Tunnel、撤销本项受限runtime key或对应Use权限；若复用其他项目资源，不盲目撤销共享key。
4. 清除本项运行环境中的key/token引用；确认已撤订后按授权清理本项签名材料。不要清其他项目、账号凭据或全局权限。
5. 项目Hook可逆移除命令：

```powershell
node agent-bridge/bin/codex-events.js hooks `
  --config .local/ydot-event-bridge-20261031/config.json `
  --project '<原CLI项目根>' --apply --remove
```

该命令只移除生成时路径完全一致的本项Handler，保留之后加入的其他Hook。备份记录existedBefore；本次原文件不存在，移除后可能保留空hooks对象，这不等于删除整个.codex目录。需要恢复“文件不存在”时，应先比较现状再由用户决定是否删除这个新建文件，不删除目录或信任记录。

只停止Tunnel或撤销其Use权限只会切断MCP入站，不能当作事件出站已停止的证据；事件callback是另一条HTTPS链路。若云端无法撤订，先停止本地事件桥接，保留状态，待授权通路恢复后完成协议撤订再重新启用，避免旧有效订阅在下次启动时继续投递。

## 7. 当前停点

已经完成普通项目Hook合并与用户信任、原CLI真实Stop采集，以及T1官方Windows客户端安装、专用绑定和真实本地doctor验证。用户已提供Tunnel ID，但Platform组织/工作区及权限范围尚未获得确认；按T1验收补充，正式凭据、本地访问令牌及云端连接均暂停，只保留无凭据检查。尚未完成原生PermissionRequest/Interrupt真实触发、真实云端discovery/订阅/回执及YDot实际通知。模拟回调、离线重试与真实本地HTTP补验不代表云端收到事件。

后续T1已获官方客户端安装、专用Tunnel、受限runtime凭据、本地认证及持续专用通道授权，进展见第8节。账户范围扩张、团队共享、新OAuth、付费承诺或安全策略变化仍需单独决定。协调端先前Edge读取因URL无法可靠识别而被阻断，未重试或绕过该路径；用户在自己的浏览器完成登录和资源创建。


## 8. T1官方Windows安装与安全启动

任务标记：YDOT-SECURE-TUNNEL-20261031-T1。用户已提供专用Tunnel ID，保存在私有binding.json；该ID由用户提供，尚未通过API核对组织/工作区关联，不是已建立连接的证明。无需将API key、签名callback或OAuth材料发到聊天。

### 8.1 安装及校验

- 来源为[OpenAI官方安装指引](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)链接的[openai/tunnel-client发布](https://github.com/openai/tunnel-client/releases/latest)。本次解析latest为v0.0.19，安装windows-amd64包；后续升级重新解析latest并复验，不盲用旧下载链接。
- 安装位置为项目内.local/tunnel-client/v0.0.19/tunnel-client.exe，不改全局PATH、网络或防火墙。可执行文件报告0.0.19+01d67bb4da0d8359b808b4761f8db171ab682cd7。
- ZIP SHA-256为1d0ecc3a54f2a51e27a635ac155f40fbb95df58c52cdeddf6c75532cc0bbeb25，同时与GitHub资产digest及官方SHA256SUMS.txt匹配。EXE SHA-256为7e93a39a567c87154a0aef2091b81100d78f9093c4603412cc2b55bed3dfe5ea。Authenticode状态为NotSigned，未验证Sigstore，不能把摘要校验说成代码签名验证。
- 官方包附带的cloudflared仅保留原包内容，配置managed=false，未运行该程序。没有安装WorkDone、Codex Tunnel插件或第三方替代。版本、来源、摘要、帮助输出及诊断保存在.local/ydot-secure-tunnel-20261031。

### 8.2 本地安全入口

**当前暂停正式启动。** 私有binding.activationApproved=false，PowerShell入口在ACL修改、隐藏输入及认证生成之前停止。仅Check可执行；下述密钥及启动流程为后续预备说明，待账号/权限范围核对并明确继续后，由本维护会话解除项目内门禁，不代用户修改任何Hook信任记录。此前发出的创建密钥/启动请求已暂停。

先在工程根目录检查绑定，不需要密钥，也不启动服务：

```powershell
pwsh -NoProfile -File tools/start-ydot-tunnel.ps1 -Check
```

专用binding.json绑定已校验EXE、profile.yaml及原有单owner allowlist的摘要，并固定用户选择的Tunnel；相关文件变化或输入其他Tunnel时拒绝启动。运行源码为tools/ydot-tunnel-runtime.cjs，PowerShell入口为tools/start-ydot-tunnel.ps1。

用户在[Platform Tunnel页](https://platform.openai.com/settings/organization/tunnels)确认专用资源和自己的组织/工作区关联；创建需Tunnels Read+Manage。再到[Runtime API keys](https://platform.openai.com/settings/organization/api-keys)创建本项运行密钥，只给Read+Use，优先使用官方说明中的per-tunnel User范围。不要给Admin key、Manage、模型调用或其他业务权限；若页面只能扩大到不符合授权的组织/团队范围，先报告再决定，不自动扩权。

保留原Codex终端，在另一个PowerShell终端运行：

```powershell
pwsh -NoProfile -File tools/start-ydot-tunnel.ps1
```

入口自动读取私有绑定的真实Tunnel ID。key通过Read-Host -AsSecureString隐藏输入，经匿名stdin管道交给本地运行入口，再仅作为受控子进程环境变量使用，不进入参数、配置或日志文件。不读取已有认证文件、不复用OPENAI_API_KEY或Admin key。内存中另生成本地Bearer，每次启动更新，通过静态转发头提供给同进程管理的MCP服务，不向聊天显示。三处本项目专用安装/状态目录设置当前Windows用户及SYSTEM访问ACL；该步骤仅在真正启动时执行，Check不改ACL。真实订阅建立后whsec会按原订阅实现持久化到受保护状态目录，不声称签名材料只在内存。

入口先启动带认证的回环MCP，运行官方doctor，再启动官方run；仅确认本地readyz返回200后输出tunnel-ready。doctor成功字符串经0.0.19源码核实为ok，不能误写成pass。配置禁止打开浏览器、cloudflared、原始HTTP日志或额外MCP命令。60秒启动观察仍不确认就停止本入口拥有的进程，不把不确定状态当成功；不自动重发业务、抢owner或删除既有锁。

运行状态写私有runtime-status.json，含本项PID、clientPid、用户选定Tunnel ID和ready状态，无key或callback秘密。现有runtime-owner.json时拒绝第二实例；异常恢复先核实精确PID，不盲删owner。原始客户端stdout/stderr直接排空丢弃，不解码、拼接、透传或落盘。doctor stdout仅用于有限长度的内部JSON解析，对外只输出固定检查ID、状态和结果枚举；异常只输出固定reason码，不输出error.message、解析片段、failed_checks原文或stderr诊断。该保证不依赖LOG_HTTP_RAW_UNSAFE=false，也不依赖替换已知密钥。

### 8.3 实测及当前边界

T1首轮tunnel-runtime专项8/8、全工作树160/160及既有验收8/8均真实执行；验收补充后的最终11/11、163/163及8/8见第8.5节。Windows可执行文件的help与配置加载实际运行；缺凭据诊断按预期退出2。实际官方doctor对真实回环MCP服务的本地探测通过，result=ok；测试control-plane仅指向本机隔离HTTP替身且请求数为零，所有ID/key均为明确fixture，未用于任何云端请求。

联调发现未实现的OAuth元数据路径原先被认证前置返回401，官方doctor将其误判为损坏OAuth；现未知路径返回404，受保护/mcp仍返回401，携带正确Bearer的initialize成功。该修复不新增OAuth、不关闭MCP认证，真实Windows doctor已复验通过。新增回归还覆盖范围/摘要变更拒绝、已有凭据隔离、分段日志脱敏、doctor实际成功契约、重复owner保护以及本地客户端启动失败后的服务/owner清理。Windows原生测试在本次机器实际执行；未安装该官方二进制或非Windows环境会明确skip此一用例，不把CI跳过算成本机通过。

现阶段没有通过代码创建云端Tunnel、key或插件；用户提供的Tunnel ID仅为资源登记。尚无真实runtime key输入、正式进程、云端订阅或投递，插件discovery、真实挑战、Stop到HTTPS回执及YDot收到通知均不能标通过。测试监听器与临时状态清理。

用户安全输入后，须逐层核实：官方ready→ChatGPT Plugins选Connection:Tunnel并选择同一个真实ID→bridge_status只读调用→父YDot实际list_event_sources/discover→父侧建立三类事件的明确订阅→原CLI自然Stop→真实签名回执和父侧摘要。当前没有已验证connector/云端端点；本地127.0.0.1地址不能给父侧冒充可连接URL。若插件要求新的OAuth或静态头被connector覆盖导致401，停在具体错误，不取消认证。

### 8.4 停止及回滚

先由父YDot撤订，确认events/unsubscribe，再在专用运行终端Ctrl+C。入口只结束自己创建的tunnel-client子进程并等待本地事件服务关闭，不关闭原Codex、Herdr或其他会话；测试已验证启动失败清理，真实长驻通道的Ctrl+C收口仍需连接后补验。

退役时再断开本项ChatGPT插件，撤销专用runtime key并删除或停用本项Tunnel；组织中共享资源不盲删。删除前保留所需非敏感安装与验收证据。只清除本入口目录时先核对进程及文件归属，不动旧协作工程未提交修改。Hook移除仍使用第6节命令；本次未改Hook定义或信任记录，无须为两个事件服务模块改动重新信任命令定义。


### 8.5 T1验收补充：输出隔离与明确暂停

协调端指出原始chunk替换的泄漏风险。复查时现文件已有按行缓冲，但仍存在原始日志转发、UTF-8逐chunk解码、超长行清空后的尾片段及异常诊断回显风险，因此取消该路径，默认不转发任何raw client日志。删除scrub/relayLines，统一discardClientOutput排空stdout/stderr；doctor的动态id/status/result与错误对象均经固定枚举投影，未知项仅为other_check/UNKNOWN/unknown或runtime_failed。main.catch不再打印error.message。

实际验证命令及结果：

| 检查 | 结果与证据等级 |
| --- | --- |
| node --test agent-bridge/test/tunnel-runtime.test.js | 11/11、0跳过；含真实Node子进程、管道及回环服务，业务客户端故障使用本地替身 |
| npm test | 163/163、0跳过；包含既有工程回归，未访问其他业务现场 |
| npm run test:e2e | 8/8；为既有交付验收，不是云端Events E2E |
| PowerShell入口无Check执行 | 实际退出1，停于activation_paused；未到密钥输入，三个目录ACL前后相同 |
| PowerShell入口-Check | 实际通过，activationApproved=false、startsServices=false、requiresSecrets=false |
| Node与PowerShell语法 | node --check及PowerShell Parser实际通过；仅证明语法 |
| Windows官方doctor | 实际本地Go程序和HTTP探测；控制面为回环替身、请求数0，无云端鉴权或Tunnel连接 |

哨兵为显式无权限UTF-8测试字符串，不是真实key；stdout/stderr按每个字节切点拆分，覆盖多字节字符、换行、EOF、超长输入和流错误。无效stdin同样覆盖每个字节切点，另有实际Node入口的坏JSON和超限输入失败退出。三个生命周期场景分别模拟doctor非法JSON、doctor失败、client失败，使用真实本地子进程和管道向两个流写入哨兵，断言回执只有固定字段、无原文或可拼接日志片段，运行证据无哨兵，owner与服务均清理。所有有效启动测试显式使用固定无权限fixtureToken，不生成生产认证。

短结果及命令日志保存在私有security-acceptance-summary.json、security-specialist.log、security-regression.log和security-e2e.log，不保存哨兵原文。首次测试中人工注入stream error使Node once(end)连带reject，已改用仅观察end的测试等待；未将该失败算为通过。

明确未测：真实runtime/API key创建、生产Bearer生成、正式ACL落地、持续Tunnel运行及Ctrl+C收口、云端插件discovery/挑战/HTTPS回执/YDot唤醒。当前账户/权限信息缺失不影响独立本地交付，准备工作已完成，保持暂停；不再请求创建或输入真实key，不重试被阻断安全UI，不重复安装、不发云端创建请求、不改原会话/owner/Hook。


## 9. C1取消接入与可恢复清理

任务标记：YDOT-BRIDGE-CLEANUP-20261031-C1。按用户取消指令结束本次接入，不恢复开发，不重新安装，不生成凭据或发起云端操作。

### 9.1 清理与保留范围

私有归档根为.local/archives/YDOT-BRIDGE-CLEANUP-20261031-C1，恢复索引为restore-manifest.json。19个迁出文件逐一保存原绝对路径、归档路径、字节数及SHA-256，移动后全部复核一致。迁出内容约91.98 MiB，仍占磁盘，没有永久删除或腾出这些空间。

| 原活动位置 | 归档位置 |
| --- | --- |
| .local/tunnel-client/v0.0.19 | client-v0.0.19/，含官方包附带但未运行的cloudflared |
| .local/ydot-secure-tunnel-20261031/tunnel-client-v0.0.19-windows-amd64.zip | downloads/同名安装包 |
| .local/ydot-secure-tunnel-20261031/profile.yaml、binding.json | inactive-config/ |
| .local/ydot-event-bridge-20261031/config.json、state/ | collector/config.json、collector/state/ |

旧运行位置不再有客户端、profile或binding；源码、测试、示例模板、交付文档，以及原两个私有目录中的校验/验收日志、安装证明和过程资料保留。collector/state/events保留6条历史原生事件，订阅和投递归档前均为0。只归档确认归属本次接入的内容，没有清空整个.local，也未改原有Tailscale、SSH、其他Agent或业务工程。

所有递归移动前验证绝对源/目标均在维护工程和本次具名目录中，逐级与逐项拒绝reparse point。使用原生PowerShell Move-Item，不跨shell拼接删除，不永久删除用户数据。归档未注册任何启动入口，原工具仍只寻找已撤出的活动绑定，不会搜索归档自动启动。

### 9.2 磁盘、运行时和信任三层结果

1. 磁盘定义：先复制当前父项目Hook文件到hooks.before.json及hooks.pre-remove.json，校验仅有三组本项定义；调用既有hooks --apply --remove精确移除。最终与预计remove结果语义一致，其他定义及顶层属性保留，不用旧备份覆盖。父hooks.json保留空hooks对象，本项定义为0。
2. 运行时：移除前官方hooks/list对原owner显示三项trusted/enabled；用户通过原终端/hooks操作后，再次只读查询得到hooks=[]，无警告/错误。没有重启、退出、resume抢owner或刷新其他会话。运行证据为runtime-hook-inventory-after.json。
3. 信任记录：维护过程未直接读取、编辑或清除底层trust存储，不能声称信任哈希已撤销。磁盘定义和当前运行清单均已移除，旧信任记录是否保留不等同于仍有活动Hook。

原采集脚本保留。已用空对象兼容探针确认：配置撤出时仍退出0并输出有效JSON对象{}，无stderr、不创建任何状态或事件；此探针不是伪造原生Stop。原启动入口--check实际退出1，固定原因required_file_missing，未启动进程或请求凭据。

### 9.3 实际验收与剩余观测

清理前和完成时的本机进程/监听查询均成功，本项tunnel-client/cloudflared、runtime和serve匹配进程为0，42589/42590监听为0；不需要停止任何进程。没有共享进程杀停、ACL变更、安装技能、删除keys或外部资源操作。

仅运行清理相关的两项Hook精确merge/remove回归，2/2通过；未重新执行无关全量测试。19个归档摘要一致，26个既有源码/交付文件哈希保持，源与测试记录保留。恢复与验收证据为restore-manifest.json、hook-removal-preflight.json、hooks.expected-after.json、runtime-hook-inventory-after.json和cleanup-verification.json。

本次最终回复可作为后续自然Stop观察点；回复结束前不能声称已经验证其结束后的事实。父协调可只读核对原采集config/state仍不存在、没有新事件或服务。已知当前运行清单为0且残留入口缺配置时不写事件，不伪造任何Stop事件以替代自然观测。

云端Tunnel、key、订阅未由本维护会话创建或删除；用户历史提供的资源ID不作为已核验或可删资源。父侧另行清理其新装内容，本机不重复处理，也不读取既有凭据或SSH配置。

### 9.4 恢复说明

仅在以后明确要求恢复时读取restore-manifest.json，先比较SHA-256和原位置是否已有新文件，再验证路径和reparse point；不要覆盖后续修改。按原路径恢复归档文件并复核，activationApproved仍为false。父项目Hook恢复应使用既有精确merge入口保留届时其他定义，备份仅作对照，不整文件覆盖当前hooks.json。运行和信任仍需各自核验，不自动启用。
