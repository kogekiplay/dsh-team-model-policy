# DSH team model policy

Independent DeepSeek Harness plugin with a **Team models / 团队模型** configuration page.

## Install

Install this public URL in DSH's Plugins page:

```text
https://github.com/kogekiplay/dsh-team-model-policy/archive/refs/tags/v0.2.0.tar.gz
```

The package ships the built browser module. No install scripts or local build are needed. Refresh the existing GUI after an upgrade.

## Configure

Open **Plugins → Team models / 插件 → 团队模型**. Select and save one mode:

- **Follow subagent model settings / 跟随子智能体模型设置**: the Lead chooses an authorized model for each teammate. The Session's original subagent allowlist remains authoritative. Unspecified reasoning effort defaults to **max**. Unsupported effort fails visibly, without falling back to disabled thinking.
- **Fixed model / 固定模型**: all named teammates use the selected provider, model and effort. An empty fixed effort follows that model's own default. Per-member switches are refused while this mode is active.

Changing the model or reasoning effort affects the next model request. A request already sent continues unchanged. Explicit `off` remains off. The Lead's route is unchanged.

## Lead tools

- `create_teammate`: supplies the native Team creation fields plus `provider`, `model` and optional `reasoning_effort`. It validates authorization and adapter support before saving the choice and calling the native Team service. Omitted effort uses the configured follow default, initially max.
- `set_teammate_model`: changes an existing teammate's next model and effort. It neither wakes the teammate nor interrupts its current request.

The original `spawn_teammate` remains available. In follow mode, omitting a per-member choice retains native inheritance. Use `create_teammate` when selecting a different model. Both fresh and fork creation remain owned by DSH's Team and continuation services.

Member choices persist in a plugin-owned storage domain keyed by the exact Team root and teammate name. They survive cold recovery. The plugin does not rewrite Team events or creation descriptors. Actual requests remain recorded in `request/header`.

The corrected `list_agents` and native creation results read each member's own request history, excluding inherited fork headers. Diagnostics distinguish historical requests from pending choices. The browser's native Team action model badge is outside this plugin's scope.

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

The mode and route fields are volatile settings. Fixed-route validation happens when that route is used, allowing an unconfigured installation to open its settings page. Model selection follows the Session-start authorization snapshot; changing the ordinary Subagent allowlist affects new Sessions.

## Compatibility

Tested with the request-waterfall runtime in Desktop 0.2.1-rc.3. Newer development runtimes exposing `Agent.model` are refused when a policy would reroute a teammate. This is an independent community plugin, not an official DeepSeek package.

Disabling the component removes listeners, prompt contributions and tools after owned operations settle. It preserves recorded requests and choices. Existing Sessions can retain their last recorded route after disablement; use a model picker or choose a new route explicitly.

## Verify

```sh
node src/client/build.cjs --check
node --test tests/client.test.mjs
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --test tests/policy.test.mjs tests/choices.test.mjs
node tests/run-integration.mjs
```

The integration suite uses `dsh --profile headless`, its real Loader, tools, Team lifecycle and persistence. Only the external LLM adapter is scripted. It checks native baseline behavior, fixed routes, cold recovery, follow-mode default max, explicit off, a mid-session model/effort switch, and route failures. It independently decodes persisted request headers with `zstd`. Every attempt is retained under `.evidence/` and excluded from Git.

`DSH_TEST_CLI` can supply a JSON launcher argv array; `DSH_TEST_INSTALL_ANCHOR` selects another matching installation; `DSH_TEST_ZSTD` selects the log decoder. The client tests render the real React card, exercise revision-fenced saves, and load the distributed factory against platform-module imports.

## Model experience

Two tools and one short policy section are added. Their schemas and tool results contribute prompt tokens. Per-member state is not injected as an unlogged prompt: actual model requests are recorded by DSH. The plugin has no API keys, telemetry, new HTTP endpoints or replacement server.

MIT licensed.
