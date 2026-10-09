# Workflow configuration and tool-argument recovery

The local Step backend provides workflow configuration independently of the upstream account rollout.
Keep the existing run-card settings UI and command contract; do not introduce another model picker.

GUI settings → session worker → workflow service preflight → successor run → original projection.
The GUI Apply action is approval for this settings-only amendment. Model-issued amendments still
require normal user confirmation. Invalid model, compilation, or missing transcript boundaries must
not stop the predecessor. Completed asks are reused; active asks restart under the selected model.
The selected provider, model and reasoning option are persisted per run and reused on resume.
No parent-session model mutation occurs. Unavailable targets fail without silently changing provider.

Tool-stream validation must not execute incomplete JSON or reconstruct missing values. Preserve
received arguments for diagnostics instead of replacing every argument object with `{}`. Block the
whole malformed batch, including valid siblings, and supply a targeted error in the native tool-result
context for one bounded correction attempt. Schema validation may happen before tool_call hooks;
the correction guidance must still reach the next request. Interrupted and oversized streams remain
terminal. Persisted post-hook messages alone do not establish what the remote provider sent.

Acceptance: native SDK fixtures for valid parallel calls, malformed/missing arguments and repair;
workflow GUI settings, independent model routing and restart, invalid-target preservation, original
permission handling, and a bounded Step Plan live run. Do not consume another API account for tests.
