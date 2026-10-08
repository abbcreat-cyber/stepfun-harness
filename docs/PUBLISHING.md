# Release boundary

This repository is a clean source snapshot of the community desktop integration, based on ZCode commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e` and integration commit `c681e217a3b1c8cec22a7296c916de61c1304a4d`.

The public snapshot excludes local Git history, credentials, conversations, private repair notes, build caches and local machine launch paths. It includes the two built-in behavior hooks and the supported third-party plugin payloads. Original license files are preserved. Screenshots were supplied by the project owner for publication.

The release target is a self-contained Windows x64 installer. It includes Step, the adapter and its production dependencies, Node, Git Bash, a relocatable Python runtime, document libraries and LibreOffice. Installation must not require the author's checkout or a separately installed development environment.

## Packaged startup contract

The unbundled Electron entry owns environment initialization and runs before importing the desktop main bundle. Paths come exclusively from `process.resourcesPath` and the user's `HARNESS_HOME` (default: the application's own AppData directory). The runtime manifest pins versions. A valid updater pointer inside that user's runtime directory can supersede the bundled Step binary. Missing required payloads fail visibly instead of selecting the upstream backend or a mock.

Startup order: packaged entry → validate payload → initialize isolated paths → import desktop → existing host → existing adapter → real Step RPC. Hooks and plugin activation keep their existing owners and protocol; packaging adds no parallel implementation. Development launch retains the source launcher. Acceptance includes path traversal rejection for update pointers, a relocated direct-EXE launch with a minimal PATH, real Step RPC against a local model fixture, hook/plugin checks and document round trips. A same-machine isolated test is not described as clean-VM validation.

The community application has an independent version line. ZCode's remote minimum desktop version must not block it; the existing Step updater remains its runtime-update owner. The Windows self-contained artifact has a 1 GiB size budget, including the document toolchain. The installer must create the star-icon desktop and Start menu shortcut named `阶跃星辰` and register normal Windows uninstall support.

## Unified update center

`HarnessUpdates` in Main owns two independent states: desktop (electron-updater, pinned to `abbcreat-cyber/stepfun-harness` GitHub releases with SHA-512 validation) and Step (existing official manifest/SHA-256 updater). Renderer uses one typed platform command and polls snapshots only while its update window exists. Each target admits at most one check/download; checking cannot reset a download or ready state. Installation is mutually exclusive, requires a ready payload and explicit user confirmation. Cancelling a download retains the available version. Closing the window does not cancel a download. ZCode feeds, remote minimum-version prompts, and developer feed overrides are never used by this community path. Desktop release publication must include installer, blockmap and `latest.yml`; pushing source alone does not update users.

## State and ownership

The launcher resolves repository paths relative to itself. `HARNESS_HOME` owns user data, settings, conversations and runtime pointers. `HARNESS_STEP_BIN` selects a real Step executable; there is no mock fallback. `HARNESS_DESKTOP_EXE` optionally selects a packaged shell. Runtime plugin declarations own enabled state. `desktop-hooks.json` owns first-principles and opening-explanation settings, read by both the settings service and the Step extension each turn.

## Checks

Before publishing: inspect the secret scan, verify screenshot hashes, plugin inventory and license notices, test launcher path resolution and Step selection, and run the targeted hook/plugin tests. No live commercial model is called by release checks. Publishing requires an explicit user request; announcements to upstream projects are a separate action.
