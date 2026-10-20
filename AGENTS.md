# AGENTS.md

本仓库编码 agent 与开发者指南。

## 文件大小

- 新增文件不得超过 5000 token（按 ceil(字节数 / 4) 估算）；修改时碰到已有的超限文件，由修改者负责拆分。Markdown（`*.md`、`*.mdx`）不受此限。
- `.githooks/pre-commit` 拦截超过 5000 token 的新增文件，这是唯一的 git hook；lint、测试等检查由 CI 负责。每个克隆启用一次：`git config core.hooksPath .githooks`。
- 拆分方法：按职责拆成内聚的小模块（每个约 2000–3000 token，一个文件只管一件事）；把类型/常量、纯函数、子组件/处理函数抽到同级文件；原路径保留为薄入口或 re-export 以保持 import 不变，否则同步改全部 import；fixture/测试数据单独成文件。不得靠压缩、删注释或空白、或往排除列表加路径来绕过。hook 报错里有分语言（TS/Go/Python）的具体示例。
