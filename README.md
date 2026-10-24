# DSH team model policy

A third-party Host plugin for DeepSeek Harness that assigns named teammates an independent LLM route and corrects model fields returned by `list_agents` and `spawn_teammate`.

This plugin targets the **request-waterfall runtime shipped in the tested 0.2.1-rc.3 desktop application**. Newer development builds with `Agent.model` require a different integration and are refused when creating or requesting a teammate.

## Install

Install the public GitHub package from DSH's Plugins page, or through the CLI:

```sh
dsh plugin --profile web add 'https://github.com/kogekiplay/dsh-team-model-policy/archive/refs/tags/v0.1.0.tar.gz'
```

Use your actual profile name. Desktop profiles belong to the desktop application; its Plugins page is the usual entry point. The package contains executable ESM and needs no build scripts, install scripts, registry dependencies, or credentials.

The bundle is selected by installation, but its policy entry starts disabled. Configure the route before enabling it. Add a profile override:

```yaml
- id: team-model-policy
  disabled: false
  config:
    provider: my-provider
    model: deepseek-v4.1-flash
    # reasoningEffort: off
```

The provider id must already be registered in DSH. That provider interprets the model id and optional effort. Omitting effort uses the chosen adapter's default and clears an inherited effort from the parent's model.

## Behavior

- The Lead keeps its own route. Named Team members use the configured route on their next request; ordinary non-Team subagents retain their behavior.
- Fresh and fork teammates stay managed by DSH's original Team and continuation services. Existing cold teammates use the policy when resumed; the plugin creates and wakes no Agent.
- New teammate routes are validated before queued work is released. Invalid routes fail creation through the original Team error path. Resumed requests validate again and fail visibly if their route becomes unavailable.
- Model fields report the member's latest own recorded request, excluding inherited fork history. Before a request exists, the field reports the configured next selection with an explicit diagnostic. A diagnostic also distinguishes a historical request from a different pinned next route.
- Cold rows read the member's persisted session through an owned read handle. The Lead model is never substituted for an unloaded teammate.
- This is a host policy. It does not add per-call model parameters to `spawn_teammate` or treat the ordinary subagent allowlist as a forced default.

DSH's creation descriptor records the route inherited before this request policy runs. The subsequent `request/header` records the route actually used. The plugin preserves both facts without rewriting history.

## Disable or remove

Disable the `team-model-policy` entry on the Plugins page or set its `disabled` override to `true`. Profile HMR applies the change when enabled; otherwise restart the profile. Use DSH's ordinary package removal operation to uninstall.

Unload stops admission, aborts and awaits in-flight policy operations, closes read handles, and removes listeners and prompt contributions. It preserves recorded requests. DSH may continue an existing session's last route after disablement; use the model picker to select another route for that session. A new teammate follows DSH's original inheritance behavior.

## Verify

The runtime entry is `index.mjs`; no compilation is required.

```sh
node --check index.mjs
node --test tests/policy.test.mjs
node tests/run-integration.mjs
```

Unit tests need `@deepseek-ai/cordis` from a matching DSH installation. Set `DSH_TEST_INSTALL_ANCHOR` to that installation's package manifest if discovery fails. On packaged macOS Desktop, run tests with Electron in Node mode so its ASAR package paths remain readable:

```sh
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --test tests/policy.test.mjs
```

The integration test launches the installed `dsh --profile headless` with the real Loader, Team tools, continuation manager, tool pipeline and persistence. Only the LLM adapter is scripted. Every attempt has a private isolated Harness home and remains under `.evidence/`. The test independently decodes persisted request headers with the `zstd` CLI. `DSH_TEST_CLI` can supply a JSON argv array for another matching launcher; `DSH_TEST_ZSTD` can select the decoder executable.

Four integration scenarios reproduce the original behavior, verify fresh/fork routes, resume existing children across processes, and reject an invalid model through the real creation tool. Nine focused unit tests cover errors, downstream blocks, fork history, HMR removal, in-flight unload and cancelled read handles. These tests establish routing and lifecycle behavior; they do not call a live Flash service or evaluate its answers.

## Model experience

The plugin adds no tools or parameters. One short system section states the Team route, adding prompt tokens and changing cached prompt text while enabled. Corrected values pass through DSH's declared output schema and renderer, keeping PTC values and rendered model text aligned.

## Scope

The plugin changes Host request policy and two model-facing tool results. It does not replace the browser model picker or Team UI. It has no network endpoints, API keys, telemetry, dependencies, or background timers of its own; requests use DSH's configured provider.

MIT licensed. This is an independent community plugin, not an official DeepSeek package.
