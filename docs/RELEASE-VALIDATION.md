# Release acceptance / 发布验收

Target: Windows x64 desktop v0.1.0, bundled Step v0.1.3.

- Windows installer completed successfully and created the `阶跃星辰` desktop shortcut. Its target is the installed EXE with no script arguments; the EXE contains the star icon. Launching the shortcut started the installed app.
- Relocated/direct-EXE startup used an isolated profile and a PATH containing only Windows system directories. No author checkout or separate Node/Python/Git installation was required.
- Installed UI completed first-run configuration, real Step chat and a native file-tool round trip using a local HTTP model fixture.
- Both built-in hooks were present and enabled, and toggles persisted through the real settings service. The first-principles instruction was observed in the model request.
- Bundled plugins loaded and marketplace refresh completed. Python Word/PowerPoint/Excel/PDF read-write checks, LibreOffice PDF conversions and Node document-library imports passed.
- Real Step 0.1.3 ran two workflow actors concurrently (two overlapping local model requests), then executed a Windows command and completed the workflow.
- The unified update window rendered in light and dark themes, reported Step 0.1.3 current, and used the project GitHub feed for desktop releases. ZCode minimum-version checks are excluded from the community entry and guard.
- `pnpm typecheck`, `pnpm lint` and architecture checks passed (lint retains existing warnings). Harness regression suite: 11 passed. Workflow suite: 24 passed. Source secret scan: no findings.

Verification was performed on a Windows 11 host with isolated directories, not a clean VM. Model fixtures prove transport/tool integration, not every provider's model behavior. Separate inherited desktop-only TypeScript project configurations still report pre-existing errors outside the supported root `typecheck` command. The installer is unsigned. Original third-party plugin/runtime licenses remain in force.
