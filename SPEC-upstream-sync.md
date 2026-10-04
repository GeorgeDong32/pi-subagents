# Spec: surface-tuning 全量同步上游 main（88 commits，merge + 方案 B）

> 状态: REVISED（对抗 review 1 轮完成：1 P1 + 6 P2 + 7 P3，全部处置见各节 [R#] 标记；按流程不再送第二轮）
> 仓库: GeorgeDong32/pi-subagents（fork），目标分支 `surface-tuning`，上游 `nicobailon/pi-subagents` main @ 8983754b
> 本文为过程文档，merge 验证通过后可删除。

## 1. 背景

- fork 落后上游 88 commits（含 v0.74.0 / v0.75.0 两个版本节点、undici 安全 bump、大量 mission/cost/MCP/watchdog 修复）。
- 2026-10-04 已 cherry-pick #2634（后台 subagent 启动修复，`d77be232`），本 spec 覆盖**其余全部**上游变更。
- fork 侧 15 个自有 commits 为 surface-tuning 系列（CC-parity TUI 调优），改动面 21 文件 +513/-195。

## 2. 上游变更冲击面（需人工解决的交集）

| 上游变化 | 冲击的 fork 特性 |
|---|---|
| #2588 (BREAKING): `workflowScript`/`workflowScriptPath` 参数删除，改为 `workflow: true`（reply fenced block）/ `workflow: "./path.js"`（含 `/` 即路径）/ 命名资源 | `workflowLaneKeys()`、`formatWorkflowManifest()` 的输入源（原挂在 `args.workflowScript`） |
| #2543: `disabledFeatures`/`featureText` 重构，描述按特性拼装，`safetyGuidance(on)` 派生 | `withLabelGuidance()` 包装器（其按 `SUBAGENT_SAFETY_GUIDANCE` 常量字符串后缀定位的假设失效） |
| #2594: executor 进程内单次加载 | `subagent-executor.ts` 的 uiLabel stash 改动（+13 行） |
| #2595: 按 model 决定 tool activation 时机 | label guidance 的投放路径（见风险 1，merge 前可定性） |

**零冲突区（自动合并，预期直接保留）**：`tui/fleet-status.ts`（上游 0 commits）、`workflows/workflow-checklist.ts`（0）、`tui/render.ts`（上游仅 4 个小 fix）、schemas 的 label 字段定义、slash-commands、watchdog/register-main。

**[R P2-6] 人工核对区（预期可自动合并，但 fork 标记行须逐个确认仍在且类型引用完整）**：`shared/types.ts`（:2043 UI label 字段）、`runs/background/async-job-tracker.ts`（rememberDispatchLabel / roster 合并）——上游 mission/cost 类变更触碰 types 概率不低。

## 3. 同步策略：merge（已定案）

- `git merge upstream/main --no-edit`，在 `surface-tuning` 本支执行。
- 否决 rebase（15 个 commit 逐个撞同批冲突）与重建分支（丢细粒度历史）。
- **[R P1-1] 预期冲突 4 文件**：`src/extension/index.ts`、`src/extension/tool-description.ts`、`test/unit/schemas.test.ts`、**`test/unit/tool-description.test.ts`**（fork 在 10 处断言包了 `withLabelGuidance(...)`，#2543 重写同区域，必然同行双改；**处置策略：按 §4.2 改写断言为对拼装结果的断言，禁止整体取上游**——否则 label 断言静默消失而门禁仍全绿）。`package-lock.json` 冲突取上游。

## 4. 冲突解决设计

### 4.1 `src/extension/index.ts`

**删除**：`args.workflowScript` / `args.workflowScriptPath` 两个渲染分支（上游 `public-execution.ts` 的 `REMOVED_WORKFLOW_SCRIPT(_PATH)` 错误提示已是现行契约——VISION「删就删干净」）。

**保留（原样）**：label headline 分支——位置在 workflow 分支之后、普通 agent 分支之前。

**改造（方案 B 核心）**：`workflowLaneKeys(script)` 解析器完整保留，`formatWorkflowManifest` 输入按 `args.workflow` 值分派：

| `args.workflow` 值 | 渲染 |
|---|---|
| `true` / `"true"` | 上游默认 `"workflow (reply block)"`，不做任何摘要（script 全文就在 call 上方消息里） |
| 含 `/` 的 string（path 形态） | 解析路径 → 读文件 → `workflowLaneKeys()` → CC-parity manifest |
| 其他 string（命名资源） | 上游默认 `workflow <name>` |
| 其余值（false/数字等） | 不拦截，落默认 agent row（无害） |

**[R P2-1] path 形态的路径解析基准**（对齐 executor 语义 `path.resolve(resolveRequestedCwd(runtimeCwd, params.cwd), workflowScriptPath)` 的可渲染子集）：`path.resolve(process.cwd(), args.cwd ?? ".", rel)`；**`args.machine` 存在时直接降级为默认文案**（远端 cwd 无法本地解析）。残余风险记录：process.cwd() 下存在同名相对路径时会渲染无关脚本的 lanes（接受，概率低、无副作用）。

**path 形态的 IO 设计**：module-level 缓存 `Map<绝对路径, {mtimeMs, lanes}>`。**[R P3-3] 热路径治理**：stat 每渲染最多一次（mtime 未变即用缓存，不 re-read）；**负缓存带 TTL**（ENOENT 结果缓存 ~5s，防不存在路径每帧重试）；**Map 容量上限**（如 32，超限逐出最旧）。解析/读取任何失败静默降级为上游默认文案。

**[R P2-2] 分派表实施前置核对**（见 §7 step 0）：分派必须与上游 executor 对 `workflow` 值的归一化实现一致（资源 vs 路径优先级、`"true"` 归一化），以 `git show upstream/main` 实读为准，不按本表字面照抄。

**VISION 合规**：path 形态是上游现行契约，manifest 是其上的渲染增强，不是给已删 `workflowScript` 留兼容路径；reply-block 不发明新数据通道（renderCall 无 ctx，preflight 无 agent/task）。

### 4.2 `src/extension/tool-description.ts`

上游结构：`defaultDescription(on) = on("workflow-scripts", scriptExecutionGuidance(on), structuredExecutionGuidance(on)) + "\n\n" + safetyGuidance(on)`；`COMPACT = DEFAULT`；`FULL = defaultDescription + WORKFLOW DETAILS`；custom → `withMandatorySafetyGuidance(custom, safetyGuidance(on))`；静态导出由 `allEnabled` 派生。

**label guidance 移植**：删除 `withLabelGuidance()` 及其调用，label 指引并进两处拼装点，safety 段永远最后：

1. `defaultDescription(on)`：`...executionGuidance + LABEL_GUIDANCE + "\n\n" + safetyGuidance(on)`（覆盖 default/compact/full）；
2. `withMandatorySafetyGuidance(custom, safety)`：`custom + LABEL_GUIDANCE + safety`。

**[R P2-4]** `withMandatorySafetyGuidance` 现有的剥离（内嵌 SAFETY/FAILURE_RECOVERY 指引）与 placeholder 去重语义**原样保留**，钉住这两条行为的现有测试不动。

`SUBAGENT_LABEL_GUIDANCE` 常量文本沿用 surface 现版。

**测试（[R P1-1] 处置策略）**：`tool-description.test.ts` 的 10 处 `withLabelGuidance(...)` 断言改写为对拼装结果的断言（描述含 label 指引、safety 段为最后一段），**禁止整体取上游**。

### 4.3 `test/unit/schemas.test.ts`

- surface `<= 13_200` vs 上游 `<= 13_010` 冲突：merge 后**实测** `JSON.stringify(SubagentParams).length`，断言写为实测值向上圆整到十位。
- 其余断言（无 `$ref`/`$defs`、`Evidence policy;` 计数等）取上游，label 字段存在性加显式断言。

### 4.4 `src/runs/foreground/subagent-executor.ts`（非冲突但人工核对）

**[R P3-2 更正描述]** fork 侧改动实为 fleet roster 的 **uiLabel stash**（`subagent-executor.ts:3531-3543` 摘录 label/task → `async-job-tracker.ts:71`），非「lane key 标注」。与 #2594 单次加载机制预期无语义冲突；merge 后人工重读确认 stash 调用点在新加载路径下仍被执行，且 `shared/types.ts`、`async-job-tracker.ts` 的 fork 标记行完整（并入 G4）。

## 5. 验证门禁

| # | 门禁 | 通过标准 |
|---|---|---|
| G0 | 基线 | **[R P2-5] merge 前录基线并落盘**：`SPEC-baseline-failures-2026-10-04.txt`（已录：3442 tests，18±3 个环境/flaky 失败，以文件中的名字集合为准） |
| G1 | `npm ci` | exit 0（merge 后重跑，依赖已变） |
| G2 | `npm run typecheck` | exit 0（基线已验证 exit 0） |
| G3 | `npm run test:unit` 全量 | **[R P2-5] 集合对照**：merge 后失败集合 ⊆ 基线集合（名字级），零新增 |
| G4 | 受影响面重点核对 | 五个测试文件（tool-description / fleet-status / schemas / host-peer / workflow-checklist）绿；**[R P2-6]** `shared/types.ts`、`async-job-tracker.ts`、`subagent-executor.ts` 的 fork 标记行人工确认 |
| G5 | 真机重启 pi 回归 | ① 后台 subagent：起 async delegate 任务，确认启动无 `agent-core/node` 类错误且结果回传（#2634 验证法内联于此）② `workflow: true` reply-block 形态可执行 ③ 普通调用 call row 显示 label headline ④ fleet roster 渲染正常 |
| G6 | CHANGELOG | Unreleased 记一条同步条目（版本节点 + 关键修复类目，不逐条虚抄） |
| G7 | 工作树 | 零冲突标记、零残留调试代码；**[R P3-7]** `rg -n "args.workflowScript|args.workflowScriptPath" src/` 零命中；spec 与基线文件处置向用户报告 |

## 6. 风险与回滚

- **风险 1（[R P2-3] 提前定性）**：label guidance 可达性——fork 现架构已核实「激活后 description 必在工具列表，catalog 仅文件级 description」，#2595 改的是激活时机而非 description 伴随性；**merge 前读 upstream/main 源码定性**（activation 链路是否仍把 tool description 完整交给模型），不必押后 G5。若需 prompt metadata 补救：注意 `buildSubagentToolPromptMetadata` 仅 default mode 返回 snippet/guidelines（custom/compact/full 返回空），custom 模式下该补救不生效——届时改拼装点而非 metadata。
- **风险 2**：Windows 矩阵不本地复验，靠上游自身测试覆盖。
- **风险 3**：schema 尺寸——§4.3 实测收紧已覆盖；label 使序列化膨胀 >500 chars 时压缩字段 description 文案。
- **回滚（[R P3-1] 措辞更正）**：merge 前打 tag `pre-upstream-sync`——**这是唯一完整回滚点**（origin/surface-tuning = 9157ac43 不含 cherry-pick 的 d77be232，不可作回滚目标）。任何阶段失败 `git reset --hard pre-upstream-sync`。

## 7. 实施顺序

0. **前置核对（[R P2-2]）**：`git show upstream/main` 实读——executor 对 `workflow` 值的归一化（路径 vs 资源优先级、`"true"` 处理）、`renderCall` 分支形态、`REMOVED_WORKFLOW_SCRIPT` 常量、`withMandatorySafetyGuidance` 双参签名、activation 链路对 description 的消费点（风险 1 定性）。发现与 spec 不符处以实读为准并回写 spec。
1. `git tag pre-upstream-sync` → `git merge upstream/main --no-edit`
2. 按 §4 逐文件解决冲突，顺序：`index.ts` → `tool-description.ts` → `tool-description.test.ts`（[R P1-1]）→ `schemas.test.ts`；`package.json` 如冲突先 `git diff upstream/main...surface-tuning -- package.json` 三向核对再取舍（[R P3-5]）；lock 取上游
3. `npm ci` → G2 → G3/G4（集合对照基线）
4. CHANGELOG（G6）
5. code-review 对抗 ≤2 轮（glm-5.3-flash 高思考，fresh context，P1/P2/P3 分级处置）
6. 真机重启回归（G5，需用户配合重启）
7. 向用户报告效果，push 决定权在用户

## 8. Out of scope（重申）

push origin、向上游提 PR、方案 A（preflight 摘要）、上游新功能（schedules/missions/worktree-cleanup）的深度调优、reply-block manifest 渲染。

## 9. Known issues（对抗审查 Round 1 处置台账）

- **P2-1（已修）**：custom 拼装点补 `assertLabelGuidancePlacement`，default 补 `endsWith(SAFETY)` 绝对序钉子；full 形态不适用 endsWith（上游 full 以 WORKFLOW DETAILS 结尾）。
- **P3-1（记录不改）**：`workflow: false/数字` 会被拦进 workflow 分支渲染 `workflow false` 等文案——仅无效入参可达（executor 随后报错），SPEC 自标无害。
- **P3-2（已修）**：删除 formatWorkflowManifest 注释中与实现不符的「color them apart」半句。
- **P3-3（记录）**：renderCall 同步路径首帧/缓存 miss 遇 MB 级脚本会一次性阻塞 UI；现实脚本 KB 级，TTL 已限频。
- **P3-4（记录）**：缓存逐出 FIFO 非 LRU；LIMIT 32 下无实际影响。
- **P3-5（台账记录，fork 既有设计非本次引入）**：slash 白名单压制 `subagents/subagent-cost/subagents-fleet/subagents-models/subagents-inspect-rpc` 等注册，与 `test/integration/slash-commands.test.ts`（upstream 版）结构性冲突——依赖可解析环境下必 TypeError。本 fork 门禁只跑 `test:unit`（不含 integration），CI 仅 push main/PR 触发，当前照不到；后续若要跑 integration 需先决策白名单与 integration 的取舍。
- **P3-6（记录）**：schemas 断言 13,070 = 实测 13,066 向上圆整，作 ratchet 用（红了即强制重测）。
- **残余风险**：process.cwd() ≠ 会话 ctx.cwd() 时同名相对路径 manifest 可能读错文件（[R P2-1] 已接受）；三门禁（G2/G3）已在实施侧实跑通过（reviewer 无 shell 未复跑，属分工非缺口）。
- **P3-8（台账补记）**：上游测试 `renders the workflow source without reading the script`（index-child-registration.test.ts）的命名哲学与 fork 的 path-manifest 特性存在张力：它恰好钉住了文件不存在时的降级路径（负缓存→上游默认文案）；若未来上游在该测试 cwd 放置同名真文件，fork 的 manifest 渲染会改写文案而挂测试——同步时留意。

## 10. G5 真机回归证据（2026-10-04，新代码活体验证）

- ① 后台 subagent：headless `pi -p`（加载本工作树新代码）派 async delegate → headless turn 结束前交付（上游 #2666 行为）→ 回传 `headless-verify-ok` ✔
- ② workflow reply-block：headless `pi -p` 写 ```js workflow fenced block + `subagent({workflow: true})` → 执行回传 `wf-verify-ok` ✔
- ③ label call-row headline：真实注册流程 + `renderCall` 活体调用——`{label: "Verify rendering", async: true}` → `"subagent Verify rendering [async]"`（label 即整个 headline，无 agent 名/task 摘录）；无 label → `"subagent scout Inspect the seam"`；空白 label → 回落 `"subagent scout"` ✔
- ④ fleet roster：`test/unit/fleet-status.test.ts`（fork 侧 238 行断言：roster 树/selection arrow/token spend/skeleton）+ fleet-transcript/widget-nested-render 于 G3 全量绿 ✔
