# Lean offline Windows runtime

The desktop installer continues to include Step, both built-in hooks, plugins and all document capabilities. This change replaces the full LibreOffice desktop distribution with a pinned native LibreOffice kit and filters development-only files from copied production packages. Existing releases and user data are not edited in place.

## Ownership and interfaces

`tools/office` owns document conversion, spreadsheet recalculation and document/page rendering. It exposes an explicit CLI and a limited `soffice` compatibility entry for existing plugin commands. Unsupported flags fail with a useful error; they never report success. Each operation owns a temporary output and commits it only after success, preserving an existing destination on failure or cancellation. The Windows wrapper owns a kill-on-close process job, so cancellation terminates Node and the native converter together.

The installed environment supplies absolute `HARNESS_OFFICE_CLI` and `STEPCODE_NODE` paths. Plugin scripts use those paths for recalculation rather than writing a global LibreOffice Basic macro. Existing conversion commands resolve the bundled compatibility executable on the child process PATH. Only child environments change; the user's global PATH and other applications remain untouched.

Flow: plugin or shell command → bundled Office CLI → pinned kit/native engine → temporary output → validated destination. There is no runtime engine download, model request or system Office fallback. The installer/runtime staging must provide Microsoft's required app-local C++ runtime alongside the native engine, with its notices.

The runtime packer is the sole owner of copy/prune policy. Tests, fixture suites, coverage, bytecode and separate sourcemaps are omitted where classified as development assets; runtime assets, bundled skill documentation, source licenses and TypeScript libraries used by the workflow compiler remain. JavaScript text is not rewritten by regular expressions.

## Acceptance

- Real DOCX/PPTX/XLSX generation, conversion to PDF, and PDF/page rendering using only bundled tools.
- Formula recalculation preserves formulas, updates cached results and reports formula errors.
- Chinese text, tables, charts, embedded images, page counts and extracted content checked against representative fixtures; compare visual output with the previous full engine.
- Paths with spaces/non-ASCII, existing destinations, invalid input, timeout and process cancellation.
- Relocated minimal-PATH startup; both hooks, plugins, local-fixture chat, native tools and parallel workflows.
- The complete installer creates the star-icon shortcut, starts normally, upgrades and uninstalls; source and package checksums are recorded before publishing.
- Report measured compressed and installed sizes separately. Do not promise a target size before packaging.
