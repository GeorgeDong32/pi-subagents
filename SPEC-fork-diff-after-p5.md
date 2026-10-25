# P5 fork 差异清理记录（2026-10-05）

基线：`8983754b`（上游 merge-base）→ `0ebb9c83`（surface-tuning fork）→ 本分支（presentation-seam）。

## 已删除（纯视觉，迁移至 CC-TUI adapter）

| 原位置 | 内容 | 迁移落点（GeorgeDong32/pi-claude-code-tui） |
| --- | --- | --- |
| `src/tui/fleet-status.ts` CC-parity roster（默认展开、`● main`/`○ agent`、紧凑 tok·time 右列、行内 glyph 选择） | frame 化后归 CC adapter | `extensions/lib/cc-subagent-rows.ts` drawCcFleetFrame（字节级等价验证于 P2/P3） |
| `src/extension/index.ts` renderCall CC-parity 分支（label 标题、humanized 默认行、workflow manifest） | 回退上游形态 | `extensions/lib/cc-rows.ts` subagentCallSummary（既有） |
| `src/extension/index.ts` `workflowLaneKeys`/manifest 缓存（D 类） | 随 renderCall 回退失去消费者，删除 | CC 侧自有 `lanesOfWorkflow`（cc-rows.ts） |
| `src/tui/render.ts` 结果行 CC 化（运行中零行、⎿ 槽嵌套、"subagents" 复数） | 回退上游形态 | CC 工具行的 gutter 家族（ccResult，force 模式下） |

native adapter（`drawNativeFleetFrame`）现按上游语义绘制：非交互时折叠单行摘要 + `↓/← to inspect`，交互时帮助行 + 展开树 + 完整 token 格式。与 8983754b 原渲染器字节级等价（44/44 上游测试 + 双实现同状态对比验证；唯一保留差异见下）。

## 保留（非视觉定制 / 能力 / 文档）

| 类别 | 位置 | 理由 |
| --- | --- | --- |
| 非视觉：label 通道（模型契约） | `schemas.ts` `label` 字段、`tool-description.ts` SUBAGENT_LABEL_GUIDANCE、`runs/*` label stash | CC 调用行 label 来源；删除即回退 |
| 非视觉：checklist 措辞 | `workflow-checklist.ts` FALLBACK_PHASE_LABEL("Tasks")、"· " 分隔、running 措辞 | `formatWorkflowChecklistText` 被 `run-status.ts`/`async-status.ts` 的**模型可见 content 路径**复用（spec §11 明示检查项）；因此 native roster 的 phase 行也带 fork 措辞——与 8983754b 的唯一保留差异 |
| 非视觉：命令过滤 | `slash-commands.ts` /subagents-* 白名单、`watchdog/register-main.ts` 抑制 | 控制行为定制 |
| 能力：展示 seam | `presentation-seam.ts`、fleet-status frame 投影/coverage、extension 接线 | 通用接口提交，待上游 PR |
| 文档 | `CHANGELOG.md`、`SPEC-*.txt/md` | 过程记录 |

## 验证

- `npm run typecheck` 绿；fleet-status 44/44（8983754b 原测试）、presentation-seam 14/14、fleet-status-seam 4/4。
- 全量 `npm test`：3779 tests，失败全部属于已知环境集（macOS /var symlink、Herdr socket、render-helpers 宽度断言等，与 0ebb9c83 基线一致，无新增）。
- 双实现对比（8983754b worktree vs 本分支，collapse/expand × 20/40/80/120 列）：除上述 checklist 措辞外逐行一致。

## P6 上游更新演练（2026-10-05）

- 区间：`8983754b → 6826b054`（上游 15 提交）。
- 合并：仅 CHANGELOG.md 平凡冲突（双侧条目保留）；`src/extension/index.ts`（±59）、`async-job-tracker.ts`（±6）自动合并成功；`fleet-status.ts` / `render.ts` / `fleet-status.test.ts` 上游未动。
- 验证：typecheck 绿；fleet-status 44/44（8983754b 原测试）、presentation-seam 14/14、fleet-status-seam 4/4、render-helpers 除既有 flaky 2 项外全过（与合并前失败集完全一致，零新增）。
- **CC adapter 零修改**：协议 v1 主版本不变，本仓库对上游无内部 Map/私有类/文件路径访问——seam 达标判据（spec §11）成立。
- 端到端（合并后代码）：bridge probe→注册 `cc-tui`→CC 展开形态渲染→`stop()` 撤回→原生折叠摘要行恢复。
- 演练分支已删除（`drill/upstream-6826b054`，结果记录于此）。

## P7 上游更新（2026-10-25）：v0.79.1 → v0.82.1（213 提交）

- 区间：`95683a44 → 35d45d98`（v0.79.1 → v0.82.1），merge commit `786cdbb4` + 测试适配 `73103467`。
- 冲突：69 文件（merge-tree 预演 201 块）。解法：除 7 个 fork 定制核心文件外全取上游（fork 侧"增量"大半是 v0.79.1 同步内容，已被上游演进吸收）；核心文件逐块合并——label 通道（schemas/tool-description/types 的 AsyncJobState.label）、seam（render.ts 的 seamCompose/seamDraw 与上游 elapsedSuffix 并存）、f600aaae ⎿ 行（subagent-messages 保 fork 组件，吸收上游 customMessageText helper 色与 auto-resume kind）、watchdog（上游 slashCommand 选项 + fork viewOnly details）。
- 移植回上游版之上：async-job-tracker 的 `rerenderAsyncWidget` + `seamDraw` option（fork seam 重绘依赖）；skills references 目录随上游瘦身删除。
- 测试适配：特征 pin 补 elapsed 后缀；⎿ 系测试恢复 fork 版 + 移植上游 auto-resume/enableSlashCommands 测试（后者适配 fork 白名单）；view-only 测试期望上游 `<pi_subagents_notice>` 包裹标记（非幂等 by design，旧包裹回灌断言退役）；schemas 预算恢复 fork 的 2200/2550（+label）。
- 验证：tsc 绿；unit 4264/4287，失败集与合并前基线名集合零新增（6 个全为已知环境 flaky）。真机：同步子代理往返（label 标题 + ⎿ completed 行）与 async 后台任务（single · running 行 → 完成自动唤醒回传）全通。
- **内存量化（post-GC，15M 会话挂载，真机包加载形态 A/B）**：407.5M → 295.2M（**-112M / -28%**）。注：上游 bundle（#3006）是 npm 发布产物（dist-pkg，build:pkg 生成），git 安装按上游设计仍走 `pi.extensions=./index.ts` 源码加载——本收益全部来自上游代码瘦身（skill 10.6k→3k、role prompts 去重、每请求工具文本瘦身等）。
