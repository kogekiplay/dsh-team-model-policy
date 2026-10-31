# DSH team model policy

Independent DeepSeek Harness plugin with a **Team models / 团队模型** configuration page.

## Install

Upgrade DSH to **0.2.1-rc.5**, then install this public URL in DSH's Plugins page:

```text
https://github.com/kogekiplay/dsh-team-model-policy/archive/refs/tags/v0.6.0.tar.gz
```

The package ships the built browser module. No install scripts or local build are needed. Refresh the existing GUI after an upgrade.

## Configure

Open **Settings → Team models / 设置 → 团队模型** in the left navigation. Select and save one mode:

- **Follow subagent model settings / 跟随子智能体模型设置**: the Lead chooses an authorized model for each teammate. The latest saved Subagent allowlist is authoritative, including for an existing Team. Unspecified reasoning effort defaults to **max**. Unsupported effort fails visibly, without falling back to disabled thinking.
- **Fixed model / 固定模型**: all named teammates use the selected provider, model and effort. An empty fixed effort follows that model's own default. Per-member switches are refused while this mode is active.

The follow-mode default reasoning effort is editable on this page: max (initial default), high, medium, low, or off. Save the choice to apply it when the Lead leaves effort unspecified. The two modes appear as selection cards. The page uses DSH’s shared save form, adapts to narrow windows, and follows the active light or dark theme. Changing the model or reasoning effort affects the next model request. A request already sent continues unchanged. Explicit `off` remains off. The Lead's route is unchanged.

## Lead tools

- `list_teammate_models`: refreshes currently authorized providers and models from the live Subagent settings. Supply a provider to list models, and an exact provider/model to inspect supported reasoning efforts. No new main Session is needed.
- `create_teammate`: supplies the native Team creation fields plus `provider`, `model` and optional `reasoning_effort`. It validates authorization and adapter support before saving the choice and calling the native Team service. Omitted effort uses the configured follow default, initially max.
- `set_teammate_model`: changes an existing teammate's next model and effort. It neither wakes the teammate nor interrupts its current request.
- `remove_teammate`: Lead-only operation that durably removes a named teammate, stops its current work and owned background jobs, returns unfinished tasks to the unassigned board, and keeps its conversation history. The name remains reserved and cannot be reused. In the Team popup, each teammate also has a Remove action with confirmation. The same operation is available as `/team-remove <teammate-name>` without an LLM request.

The original `spawn_teammate` remains available. In follow mode, omitting a per-member choice retains native inheritance. Use `create_teammate` when selecting a different model. Both fresh and fork creation remain owned by DSH's Team and continuation services.

Member choices persist in a plugin-owned storage domain keyed by the exact Team root and teammate name. They survive cold recovery. The plugin does not rewrite Team events or creation descriptors. Actual requests remain recorded in `request/header`.

Removing a route blocks future selections and requests for that route; a request already sent can finish. Removing a teammate also archives its Session with stop activity, filters it from the Team popup and `list_agents`, and rejects both model-side messages and later GUI attempts to resume it. If a stop or task cleanup cannot finish, the state remains `removing` with an actionable error and the Lead can retry. Disabling Subagent model selection blocks future requests in follow mode. Member history remains visible so the Lead can select an allowed recovery route. Fixed mode remains an explicit Host route policy.

The corrected `list_agents` and native creation results read each member's own request history, excluding inherited fork headers. Diagnostics distinguish historical requests from pending choices. The browser's native Team action model badge is outside this plugin's scope.

## 手动清理子智能体 / Manual subagent cleanup

普通子智能体不一定是 Team 成员。本插件保留两条独立路径：

- 在会话标题栏的 **子智能体** 下拉列表中，点击某个本地子智能体旁的 **移除**，阅读确认说明后执行。嵌套子会话保留展开、主区域打开及侧栏打开功能。
- 用户也可以在父会话中输入 `/subagent-remove <session-id>`，不需要模型推理。
- Lead 或拥有该子会话的父智能体先调用 `list_manageable_subagents` 获取准确的会话 ID，再调用 `remove_subagent`；Team 名称入口 `remove_teammate` 仍可用。
- 普通本地子智能体：停止所选子树、等待后台工作收敛、归档子会话并从插件列表和计数中过滤；刷新或重启后保持。历史日志和原生目录记录保留，不物理删除。
- Team 成员：自动转到已有退队服务，额外回收未完成共享任务，不能绕过任务回收。
- 外部执行没有可归档的本地 Session，未知或损坏目录也无法验证归属，因此这些项暂不提供移除按钮。不能移除当前会话、祖先或其他会话树中的智能体。

清理完全手动触发。**未运行不代表任务已完成或没有用处**，插件不会按空闲状态自动移除。未收敛的操作显示可重试错误并保留 `removing` 状态，只有清理成功后才从列表消失。禁用插件会恢复原生历史目录显示；已归档子会话仍保持归档。

The native subagent catalog and lineage controls gain per-entry confirmed removal. `list_manageable_subagents` discovers ordinary children and Team members by exact session ID; `remove_subagent` and `/subagent-remove <session-id>` share the Host operation. Only descendants of the invoking parent are eligible. Local ordinary subtrees are stopped and archived with history retained; Team members use the existing task-reclaiming removal flow. External executions, unknown modes and unreadable branches are refused rather than reported as removed. No automatic cleanup runs.

## Host configuration

The optional profile override uses these fields; the GUI writes the same namespace:

```yaml
- id: team-model-policy
  config:
    mode: follow-subagent
    defaultReasoningEffort: max
    provider: ''
    model: ''
    reasoningEffort: ''
```

The Host policy, retirement service, and browser settings are separate bundle entries so saving settings does not remount the settings window. The retirement service uses a plugin-owned projection and the Workspace archive admission path; native Team history and member records remain intact. The mode and route fields are volatile settings. Fixed-route validation happens when that route is used, allowing an unconfigured installation to open its settings page. In follow mode, saved additions and removals in the ordinary Subagent settings apply to existing Teams immediately. The native ordinary-subagent tools retain their original Session policy. Historical Session policy events are preserved.

## Supported DSH version

This release supports **DSH 0.2.1-rc.5 only**. Plugin releases track DSH updates: each release targets the current verified DSH version, and older DSH versions are not maintained. Upgrade DSH to the declared version before installing the matching plugin release.

本插件随 DSH 更新。本版仅支持 **DSH 0.2.1-rc.5**，后续版本针对新的 DSH 版本验证和发布，不保留旧版兼容范围。请先升级 DSH，再安装对应的插件版本。

The existing 12 Loader/headless scenarios were verified against the official 0.2.1-rc.5 npm runtime. Ordinary-subagent cleanup has additional isolated lifecycle and real React component tests. Required Client exports and contracts were checked; Desktop screenshot-level verification is reported separately from automated tests. Runtimes exposing an unsupported `Agent.model` API are refused when a policy would reroute a teammate. This is an independent community plugin, not an official DeepSeek package.

Disabling the component removes listeners, prompt contributions and tools after owned operations settle. Retired child Sessions remain archived after disablement; the native historical roster becomes visible when the popup replacement is disabled. Re-enable the plugin to restore its filtered roster. The retirement service stop budget is configurable as `jobStopTimeoutMs` under `team-member-retirements` (default 30000 ms). It preserves recorded requests and choices. Existing Sessions can retain their last recorded route after disablement; use a model picker or choose a new route explicitly.

## Verify

```sh
node src/client/build.cjs --check
node --test tests/client.test.mjs
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --test tests/policy.test.mjs tests/choices.test.mjs
node tests/run-integration.mjs
```

The integration suite uses `dsh --profile headless`, its real Loader, tools, Team lifecycle and persistence. Only the external LLM adapter is scripted. It checks native baseline behavior, fixed routes, cold recovery, follow-mode default max, explicit off, a mid-session model/effort switch, live teammate removal, the roster command, provider reload during removal, owned-worker cleanup, task reclamation, cold recovery fencing, and route failures. It independently decodes persisted request headers with `zstd`. Every attempt is retained under `.evidence/` and excluded from Git.

`DSH_TEST_CLI` can supply a JSON launcher argv array; `DSH_TEST_INSTALL_ANCHOR` selects another matching installation; `DSH_TEST_ZSTD` selects the log decoder. The client tests render the real React card, exercise revision-fenced saves, and load the distributed factory against platform-module imports.

## Model experience

Six model-facing tools and two short policy sections are added. Teammate removal is a destructive Team operation and remains Lead-only. Their schemas and tool results contribute prompt tokens. Per-member state is not injected as an unlogged prompt: actual model requests are recorded by DSH. The plugin has no API keys, telemetry, new HTTP endpoints or replacement server.

MIT licensed.
