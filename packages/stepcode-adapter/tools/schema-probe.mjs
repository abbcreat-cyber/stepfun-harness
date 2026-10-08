#!/usr/bin/env node
/*
 * schema-probe.mjs — 用仓库 tsx 直接 import @zcode/shared 的 zod schema，
 * ① dump 关键 schema 的可构造形状（字段/可选性/枚举值/discriminatedUnion 分支），
 * ② 校验 wire-shapes.mjs 工厂构造的样例帧/响应能过 strict 校验。
 *
 * 运行（在 stepcode-desktop 仓库根）：
 *   npx tsx packages/stepcode-adapter/tools/schema-probe.mjs [--dump] [--validate]
 * 默认两个模式都跑；--dump/--validate 按 process.argv 全量扫描识别，顺序无关
 * （`--dump --validate` 与 `--validate --dump` 等价，杜绝只认 argv[2] 时的静默假绿）。
 * exit 0 = 全部样例合规；exit 1 = 有样例被拒（stderr 打印 zod issues）。
 *
 * Derives from zai-org/ZCode (https://github.com/zai-org/ZCode), Apache-2.0.
 */
import process from "node:process";

const protocolModule = await import("../../shared/src/zcode-protocol/index.ts");
const legacyTypes = await import("../../shared/src/zcode-protocol-legacy-types.ts");
const v4Transport = await import("../../shared/src/zcode-protocol-v4/transport.ts");
const v4Command = await import("../../shared/src/zcode-protocol-v4/command.ts");
const v4Snapshot = await import("../../shared/src/zcode-protocol-v4/snapshot.ts");
const v4Rows = await import("../../shared/src/zcode-protocol-v4/rows.ts");
const v4Delta = await import("../../shared/src/zcode-protocol-v4/delta.ts");

/** 递归描述 zod schema 的可构造信息（限深，避免打爆终端）。 */
function describe(schema, depth = 0, maxDepth = 3) {
	if (depth > maxDepth) return "...";
	const def = schema?.def ?? schema?._def;
	if (!def) return String(schema?.constructor?.name ?? "?");
	switch (def.type) {
		case "object":
		case "strictObject": {
			const shape = typeof def.shape === "function" ? def.shape() : (def.shape ?? schema.shape ?? {});
			const entries = Object.entries(shape).map(([k, v]) => {
				const d = v?.def ?? v?._def;
				const opt = d?.type === "optional";
				const nullable = d?.type === "nullable";
				const inner = opt || nullable ? (d.innerType ?? d.schema) : v;
				return `${k}${opt ? "?" : ""}${nullable ? "?" : ""}: ${describe(inner, depth + 1, maxDepth)}`;
			});
			return `{ ${entries.join(", ")} }`;
		}
		case "string": {
			if (def.checks?.length) {
				const enums = def.checks.flatMap((c) => (c?._zod?.values ? [...c._zod.values] : [])).filter((v) => typeof v === "string");
				if (enums.length) return `enum(${enums.join("|")})`;
				return "string(checked)";
			}
			return "string";
		}
		case "literal":
			return `literal(${JSON.stringify(def.value)})`;
		case "enum":
			return `enum(${[...(def.values ?? [])].join("|")})`;
		case "number":
			return def.checks?.some?.((c) => JSON.stringify(c).includes("integer")) ? "int" : "number";
		case "boolean":
			return "boolean";
		case "array":
			return `array<${describe(def.element, depth + 1, maxDepth)}>`;
		case "optional":
		case "nullable":
			return `?${describe(def.innerType ?? def.schema, depth + 1, maxDepth)}`;
		case "union":
		case "discriminatedUnion": {
			const options = def.options ?? [];
			return options.map((o) => describe(o, depth + 1, maxDepth)).join(" | ");
		}
		case "record":
			return "record<string,unknown>";
		case "date":
			return "date";
		case "any":
		case "unknown":
			return def.type;
		default:
			return `${def.type}${def.value !== undefined ? `(${JSON.stringify(def.value)})` : ""}`;
	}
}

const DUMP_TARGETS = {
	"zcodeSessionInfoSchema": legacyTypes.zcodeSessionInfoSchema,
	"zcodeSessionRuntimeStateSchema": legacyTypes.zcodeSessionRuntimeStateSchema,
	"zcodeSessionStatusSchema": legacyTypes.zcodeSessionStatusSchema,
	"zcodeSessionModeSchema": legacyTypes.zcodeSessionModeSchema,
	"modelSelectionSchema": (await import("../../shared/src/model-selection.ts")).modelSelectionSchema,
	"zcodeSessionEventsResultSchema": protocolModule.zcodeSessionEventsResultSchema,
	"zcodeSessionMessagesResultSchema": protocolModule.zcodeSessionMessagesResultSchema,
	"zcodeMcpListResultSchema": protocolModule.zcodeMcpListResultSchema,
	"v4ConversationUnsubscribeResultSchema": v4Transport.v4ConversationUnsubscribeResultSchema,
	"conversationSnapshotSchema": v4Snapshot.conversationSnapshotSchema,
	"conversationRowSchema": v4Rows.conversationRowSchema,
	"conversationDeltaSchema": v4Delta.conversationDeltaSchema,
	"commandResultSchema(stop/inputAccepted/createSession)": v4Command.commandResultSchema,
	"zcodeTurnStartedEventPayloadSchema": protocolModule.zcodeTurnStartedEventPayloadSchema,
	"zcodeTurnCompletedEventPayloadSchema": protocolModule.zcodeTurnCompletedEventPayloadSchema,
	"zcodeMessagePartDeltaEventPayloadSchema": protocolModule.zcodeMessagePartDeltaEventPayloadSchema,
	"zcodeMessageUpsertedEventPayloadSchema": protocolModule.zcodeMessageUpsertedEventPayloadSchema,
};

// 参数判断（R3 评审 low 修复）：对 process.argv 全量 includes 扫描，任意顺序出现
// --dump / --validate 都生效；两者都未传时默认两个模式都跑（未知 flag 不再造成
// 只认 argv[2] 时的静默空跑假绿，按缺省两模式执行）。旧逻辑只认 argv[2]，实测
// `--dump --validate` 顺序下 validate 被静默跳过且 exit 0。
const flags = process.argv.slice(2);
const wantDump = flags.includes("--dump");
const wantValidate = flags.includes("--validate");
const runAll = !wantDump && !wantValidate;
if (wantDump || runAll) {
	for (const [name, schema] of Object.entries(DUMP_TARGETS)) {
		console.log(`\n=== ${name} ===`);
		console.log(schema ? describe(schema, 0, 2) : "(undefined)");
	}
	process.exitCode = 0; // 纯 dump 分支显式退出码（本分支无失败面）
}

if (wantValidate || runAll) {
	const shapes = await import("../src/wire-shapes.mjs");
	const modelSelection = (await import("../../shared/src/model-selection.ts")).modelSelectionSchema;
	const VALIDATION_TARGETS = {
		snapshot: protocolModule.zcodeSessionStateSnapshotSchema,
		turnStartedEvent: protocolModule.zcodeSessionEventSchema,
		partDeltaEvent: protocolModule.zcodeSessionEventSchema,
		turnCompletedEvent: protocolModule.zcodeSessionEventSchema,
		stateUpdated: protocolModule.zcodeStateUpdatedNotificationSchema,
		subscribeAck: v4Transport.subscribeAckSchema,
		conversationSnapshotFrame: v4Transport.conversationTopicFrameSchema,
		// 外层物理帧信封（Host 在路由边界先校验的信封：wireVersion/kind/deliveryKind/
		// logicalFrameId/logicalFrameOrdinal；裸发内层帧会被 Host 整条丢弃）。
		conversationSnapshotWireFrame: v4Transport.conversationTopicWireFrameSchema,
		sessionsIndexSnapshotWireFrame: v4Transport.sessionsIndexTopicWireFrameSchema,
		workspaceConfigSnapshotWireFrame: v4Transport.workspaceConfigTopicWireFrameSchema,
		conversationSnapshotWireCandidate: v4Transport.conversationTopicWireCandidateSchema,
		// 空 rows 快照必须过内层帧 schema（firstRowId: z.number().nullable() 必填，
		// 见 shared/src/zcode-protocol-v4/snapshot.ts:457——contentRejected 回归护栏）。
		conversationSnapshotFrameEmptyRows: v4Transport.conversationTopicFrameSchema,
		conversationSnapshotFramePrewarmingEmpty: v4Transport.conversationTopicFrameSchema,
		// P0-02：带 queue.items / inputRouting / followupMode 的快照（busy 排队态）——
		// queueItemSchema .strict() 的探针防线（队列项多一个便利字段即在此炸出）。
		conversationSnapshotFrameWithQueue: v4Transport.conversationTopicFrameSchema,
		commandResultInputAcceptedQueue: v4Command.commandResultSchema,
		accountConfigResult: protocolModule.zcodeProviderUpdateAccountConfigResultSchema,
		sessionSendResult: protocolModule.zcodeSessionSendResultSchema,
		sessionSubscribeResult: protocolModule.zcodeSessionSubscribeResultSchema,
		sessionListResult: protocolModule.zcodeSessionListResultSchema,
		commandResultCreateSession: v4Command.commandResultSchema,
		commandResultInputAccepted: v4Command.commandResultSchema,
		commandAckSendText: v4Command.commandAckSchema,
		commandAckStopNoResult: v4Command.commandAckSchema,
		sessionsIndexSnapshotFrame: v4Transport.sessionsIndexTopicFrameSchema,
		workspaceConfigSnapshotFrame: v4Transport.workspaceConfigTopicFrameSchema,
		modelSelectionDefault: modelSelection,
	};
	const samples = shapes.sampleWireObjects();
	let failed = 0;
	for (const [name, schema] of Object.entries(VALIDATION_TARGETS)) {
		const value = samples[name];
		if (value === undefined) {
			console.error(`FAIL ${name} (wire-shapes sample missing)`);
			failed += 1;
			continue;
		}
		const result = schema.safeParse(value);
		if (result.success) {
			console.log(`PASS ${name}`);
		} else {
			failed += 1;
			console.error(`FAIL ${name}`);
			for (const issue of result.error.issues) {
				console.error(`  ${issue.path.join(".")}: ${issue.message} (${issue.code})`);
			}
		}
	}
	process.exitCode = failed > 0 ? 1 : 0;
}
