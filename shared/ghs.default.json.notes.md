# `ghs.default.json` 默认模型说明

本文件记录 `shared/ghs.default.json` 中 3 个默认模型 ID 的选择理由，以及与原 Claude Code 插件 / 技术规划文档之间的差异。

## 三个角色与默认模型

| 角色 | 字段 | 默认模型 | 选择理由 |
|---|---|---|---|
| 上下文提取子代理（context snapshot） | `models.context` | `zai-coding-plan/glm-4.5-air` | 上下文快照任务是结构化信息提取（扫描文件、抽取关键路径），不需要复杂推理，使用便宜/快速的小模型即可。Phase 0 spike 验证也使用同一模型，结果稳定。 |
| 计划设计师子代理（plan designer） | `models.designer` | `zhipuai-coding-plan/glm-4.6` | 设计阶段需要较强的体系结构推理能力，使用能力更强的 GLM 4.6。 |
| 计划评审子代理（plan reviewer） | `models.reviewer` | `zhipuai-coding-plan/glm-4.6` | 评审阶段同样需要扎实推理能力，与设计师保持同级以给出有价值的反对意见。 |

## 与源插件 / 规划文档的差异

- **原 Claude Code 插件**（`/Users/tom/github/golden-hoop-spell/plugin/`）默认使用 Anthropic 模型 ID（`anthropic/claude-haiku-4-20250514` + `anthropic/claude-sonnet-4-20250514` x2）。
- **本地实际环境**（用户配置）：使用智谱 / Z.AI 的 GLM 系列模型，未配置 Anthropic。
- **Phase 0 spike 结论**：派发/模板替换/权限限制等机制均与模型无关（model-agnostic），仅是 provider/model ID 字符串不同。因此本仓库的默认值直接使用 GLM 系列，方便用户开箱即用。

## 用户自定义方式

用户可在自己项目根目录运行 `ghs-init` 后编辑 `.ghs/ghs.json`（由 `ghs-init` 自动从 `shared/ghs.default.json` 复制）来覆盖以上任一或全部字段，然后运行 `ghs-config` 工具重新渲染 `.opencode/agents/ghs-*.md` 子代理模板。例如：

```json
{
  "models": {
    "context": "anthropic/claude-haiku-4-20250514",
    "designer": "anthropic/claude-sonnet-4-20250514",
    "reviewer": "anthropic/claude-sonnet-4-20250514"
  }
}
```

注意：修改模型 ID 后必须重启 OpenCode 进程才能生效（OpenCode 在启动时读取 agent markdown，无热重载）。
