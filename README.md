# Golden Hoop Spell for OpenCode

「紧箍咒」是为 OpenCode 设计的多角色技术规划编排插件——把 Claude Code 插件 [`golden-hoop-spell`](https://github.com/anthropics/golden-hoop-spell)（参考来源）移植到 OpenCode 平台。

它提供一组 `ghs-*` 工具与三个内部子代理（context snapshot / plan designer / plan reviewer），把「需求 → 可执行技术计划 → sprint 拆分 → 落地编码」的工作流固化在 IDE 内部。上下文提取由 [codegraph](https://github.com/cursor-ai/codegraph) MCP server 提供，所有状态都序列化到项目根目录的 `.ghs/` 目录（与源插件字节兼容）。

## 安装

```bash
bun add golden-hoop-spell-opencode
# 或者直接通过本地文件链接
# bun add file:./path/to/golden-hoop-spell-opencode
```

安装后在项目根目录的 `opencode.json` 中声明该插件并启用 codegraph MCP server（详见 [`shared/opencode.json.example`](./shared/opencode.json.example)）。

## 项目阶段

当前处于 Sprint 1（Foundation: Spikes + Scaffold）。Phase 0 的 5 个架构风险 spike 全部通过（详见 [`shared/SPIKE_RESULTS.md`](./shared/SPIKE_RESULTS.md)），其中记录了 3 个与原规划文档的关键差异（codegraph 启动命令、MCP 工具命名、MCP 工具权限限制字段），这些差异已直接反映到本仓库的 scaffold 文件中。

## 文档

- [Phase 0 Spike 结果](./shared/SPIKE_RESULTS.md)
- [技术规划文档](./docs/plan/2026-06-20-opencode-port.md)
- [默认模型配置说明](./shared/ghs.default.json.notes.md)
- 参考文档：[context snapshot](./shared/references/context-snapshot-guide.md) · [plan designer](./shared/references/plan-designer.md) · [plan reviewer](./shared/references/plan-reviewer.md) · [coding agent](./shared/references/coding-agent.md) · [sprint agent](./shared/references/sprint-agent.md) · [examples](./shared/references/examples.md)
