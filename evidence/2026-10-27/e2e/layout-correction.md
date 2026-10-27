# 验收不通过：修正测试标记

主控读取真实 `layout-proof.txt`，内容仍为 `cbb|workspace-reuse|resumed`，而上一轮任务明确要求 `cbc|workspace-reuse|resumed`。CBC CLI 的规范显示名已按用户最终要求修正为 `cbc`，不得继续沿用旧测试标记或自行改写验收命令的期望值。

只修改 `layout-proof.txt` 为一行 `cbc|workspace-reuse|resumed`，并写本轮交付报告。禁止改动测试文件。逐字运行 `node --test layout-acceptance.test.cjs` 和 `node --test acceptance.test.cjs`，分别要求1/1和7/7通过。报告保留完整命令及真实通过数，不能用修改期望值的命令替代。
