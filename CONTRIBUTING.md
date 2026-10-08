# 贡献 / Contributing

欢迎提交可复现的问题和范围明确的修复。请包含操作步骤、系统版本、Step CLI 版本和经过脱敏的错误信息。不要上传密钥、令牌、私人文件或原始会话日志。

Changes should preserve runtime ownership and truthful UI state. A visible capability is not complete until its execution, cancellation, and persistence behavior are verified. Use local fixtures rather than paid model calls in automated tests.

```powershell
pnpm install
pnpm harness:prepare
pnpm typecheck
pnpm lint
pnpm harness:test
```

Run targeted tests for the changed area. For native SDK fixtures, set `STEP_TEST_CLI` to a real Step executable and `STEP_TEST_ROOT` to an isolated writable directory. For UI changes, verify the actual desktop page in both themes.

Third-party plugin licenses must be preserved. Do not copy personal plugin caches, account data, restricted assets without applicable rights, or local release binaries into the repository. Read [LICENSES.md](LICENSES.md) and [docs/PUBLISHING.md](docs/PUBLISHING.md).
