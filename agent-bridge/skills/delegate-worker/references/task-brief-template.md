# 任务规格与多轮提示模板

首次委派编写JSON规格，路径可相对于cwd。内容由Codex核实；不得照搬占位符或让执行Agent猜测。详细程度以模型能按步骤完成、主控能客观验收为准。

```json
{
  "goal": "实现端口字符串解析，接受十进制1..65535，其他输入抛错",
  "background": "调用方需要在启动前校验端口；保留现有导出形式",
  "projectContext": "项目使用Node.js CommonJS与node:test；Codex独立验收，执行Agent不自行提交",
  "inputs": [
    { "path": "src/port.cjs", "purpose": "既有接口与实现，先读再改" },
    { "path": "test/port.test.cjs", "purpose": "主控固定验收，不得改动" }
  ],
  "allowedChanges": ["src/port.cjs"],
  "requirements": ["去除首尾空格", "只接受十进制整数字符串", "校验范围并拒绝空串"],
  "steps": ["阅读输入文件并核对接口", "修改解析及范围检查", "执行原验收并记录结果"],
  "preserve": ["导出parsePort", "不得修改测试期望值"],
  "edgeCases": ["空串、0、65536、小数和指数写法均拒绝"],
  "examples": ["' 443 '返回443；'1e2'抛错"],
  "nonGoals": ["不引入依赖、不改调用方、不做无关重构"],
  "acceptance": [
    { "command": "node --test test/port.test.cjs", "expected": "退出码0，全部通过" }
  ],
  "deliverables": ["src/port.cjs及协调器指定的Markdown交付报告"],
  "stopConditions": ["接口或输入与规格不符时先报告", "无法执行验收时保留失败证据，不改标准"]
}
```

返工使用差量，例如：

> 上轮固定测试7项中2项失败：'1e2'和'1.5'未拒绝。只修十进制格式判断，保留已通过行为、接口和测试文件。按原命令重新验收，报告真实结果。

跨任务使用同一会话前先查询台账，核实实际session ID。当前目标、输入、实施要求和验收仍须明确，稳定项目背景不重复发送。新会话、引用失效或压缩后按协调器选择重发完整规格。

交付报告逐项列出修改文件、实际命令/退出码/通过失败数、未验证项及阻塞原因。不得只写“完成”，不得输出凭据或自行accept、发布。
