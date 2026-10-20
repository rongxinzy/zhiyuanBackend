# AGENTS.md

本仓库编码 agent 与开发者指南。

## 文件大小

- 新增文件不得超过 5000 token（按 ceil(字符数 / 4) 估算）；修改时碰到已有的超限文件，由修改者负责拆分。Markdown（`*.md`、`*.mdx`）不受此限。
- `.githooks/pre-commit` 拦截超过 5000 token 的新增文件，这是唯一的 git hook；lint、测试等检查由 CI 负责。每个克隆启用一次：`git config core.hooksPath .githooks`。
