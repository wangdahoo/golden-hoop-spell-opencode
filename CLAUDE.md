# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Critical Rules

- **Language policy (applies to ALL agents including subagents/parallel agents)**:
  - **Chinese**: All human-readable output — conversation with user, technical documentation (CONTEXT.md, ADRs, READMEs, inline doc comments, PR descriptions), commit messages, git branch names' descriptive parts, TODO/FIXME comments, and task/plan descriptions.
  - **English**: Source code identifiers, log messages, error strings, and LLM-facing prompts/instructions (e.g. skill definitions, agent prompts).
  - **Subagent enforcement**: When spawning any agent (Agent tool, parallel agents, worktree agents), the prompt to the agent MUST include the instruction: "使用中文回复和撰写所有文档/commit message。代码标识符、日志、错误信息用英文。" This ensures delegated work also follows the policy regardless of whether the subagent inherits this file.