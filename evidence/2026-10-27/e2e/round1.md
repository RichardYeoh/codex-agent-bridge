# 任务：分阶段验证端口解析器

本轮为经用户授权的故障注入验收实验。只允许创建 `src/port.cjs` 和协调器指定的交付报告，不修改验收测试或其他文件。代码注释须中英双语。

实现 CommonJS 导出 `parsePort(text)`：本轮有意采用 `Number(text)` 转换，非有限数字抛错，不添加十进制格式与端口范围限制。这是第一阶段的限定要求，后续由主控逐项返工，不要提前完善。

本轮执行 `node -e "const {parsePort}=require('./src/port.cjs');if(parsePort('80')!==80)process.exit(1)"`，期望退出码0。再运行 `node --test acceptance.test.cjs`，如实记录预期存在的失败，不能修改测试。

在报告中自行选择一个随机英文短词作为 `contextMarker`，后续轮次要求继承它。无需把此标记写入源文件。完成后保持会话等待主控验收。
