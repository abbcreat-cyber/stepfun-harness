#!/usr/bin/env node
/*
 * tools/schema-probe.mjs — 根路径转发入口（2026-10-05 R3 轮恢复）。
 *
 * 背景：P0 轮把根目录散落的探针整合进 packages/stepcode-adapter/ 包时，
 * 本文件正身移到了 packages/stepcode-adapter/tools/schema-probe.mjs
 * （sha256 90691811facba34ec82b711b092e5fc6e91b0ecec7cde189e01349d74cbc9a88，
 * 与 p0-plan-logs/sha256-after.txt 记录一致）。R2 门禁在仓库根执行
 * `npx tsx tools/schema-probe.mjs --validate` 时因根路径缺失而
 * ERR_MODULE_NOT_FOUND。本入口恢复根路径可用性：转发到 adapter 正身，
 * 校验逻辑（含 P0-02 的 queue 快照与 queue ACK 样例）零重复、零分叉。
 *
 * 运行（在 stepcode-desktop 仓库根）：
 *   npx tsx tools/schema-probe.mjs [--dump] [--validate]
 * 正身亦可直接运行：
 *   npx tsx packages/stepcode-adapter/tools/schema-probe.mjs [--dump] [--validate]
 * exit 0 = 全部样例合规；exit 1 = 有样例被拒（stderr 打印 zod issues）。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
await import("../packages/stepcode-adapter/tools/schema-probe.mjs");
