// 宿主 ACK 透传防漂移（R3 评审 high 的断言半段，2026-10-06）。
//
// 宿主链路（协议级等价性依据）：services 的 sendConversationCommandV4 以
// client.request(V4_METHODS.command, envelope, commandAckSchema) 消费 ACK
// （packages/services/src/zcode-agent/zcodeAgentService.ts），底层
// zcodeProtocolClient.resolveResponse 以 resultSchema.parse(result) 的输出
// resolve，且 services 层拿到的 ack 原样 return 上层（渲染层链路的宿主半段）。
// 因此「commandAckSchema.parse 输出里 fallbackReasonCode 存活」⇔「宿主透传到
// 上层」——本文件用与宿主完全相同的 schema 实例与 parse 调用形态做协议级锁定：
// ACK 带该字段时完整到达；shared 的 inputAccepted 声明被删时（zod 非严格对象
// 默认 strip 未知键、parse 不报错），本测试必红。
// UI 消费现状（spec §9 ①）：徽标读 queueItem 投影双槽，不依赖本字段——本测试
// 锁的是协议可达性，不是 UI 行为。
import { test } from "node:test";
import assert from "node:assert/strict";
// 运行需 tsx 加载器（node --import tsx --test 本文件）：shared/src 全树用 TS 的
// .js 扩展名 import 惯例（如 command.ts 内部 import "../localTtft.js"），纯 node
// 原生 type-stripping 不做 .js→.ts 回退解析（Node 24 实测 ERR_MODULE_NOT_FOUND）。
// 聚合入口：packages/stepcode-adapter/suites/shared-passthrough.mjs 以 tsx 子进程
// 把本文件挂进 adapter 全量门禁（test/index.js）。
import { commandAckSchema } from "../src/zcode-protocol-v4/command.js";

// 与宿主 zcodeAgentService 收到的 ACK wire 同形：status=accepted + result 分支。
const ackWire = (result: Record<string, unknown>) => ({
  commandId: "cmd-r3h-ack",
  status: "accepted",
  revisionAtDecision: 7,
  result,
});

test("inputAccepted ACK 的 modelDeferred 经宿主同款 parse 完整到达上层（声明被删必红）", () => {
  // 桥侧真实形态：忙碌排队 + 显式模型选择 → delivery=queue +
  // fallbackReasonCode=stepcode.community.modelDeferred（spec §9、能力矩阵 §1.1）。
  const parsed = commandAckSchema.parse(
    ackWire({
      type: "inputAccepted",
      delivery: "queue",
      inputId: "cmd-r3h-ack",
      fallbackReasonCode: "stepcode.community.modelDeferred",
    }),
  );
  const result = parsed.result;
  assert.ok(result?.type === "inputAccepted", "ACK result 必须解码为 inputAccepted 分支");
  assert.equal(
    "fallbackReasonCode" in result,
    true,
    "parse 输出必须保留 fallbackReasonCode 键——shared inputAccepted 声明被删时此处即红（zod strip 未知键且不报错）",
  );
  assert.equal(
    result.fallbackReasonCode,
    "stepcode.community.modelDeferred",
    "降级标记码必须逐字透传到宿主可见层（不能只剩键丢值）",
  );
});

test("inputAccepted ACK 的 noAtomicPreempt（steer 近似场景）同样经 parse 存活", () => {
  // busy+startNow 走 steer 降级近似：ACK delivery=queue +
  // fallbackReasonCode=stepcode.community.noAtomicPreempt（spec §9、能力矩阵 §1.1）。
  const parsed = commandAckSchema.parse(
    ackWire({
      type: "inputAccepted",
      delivery: "queue",
      inputId: "cmd-r3h-ack",
      fallbackReasonCode: "stepcode.community.noAtomicPreempt",
    }),
  );
  const result = parsed.result;
  assert.ok(result?.type === "inputAccepted");
  assert.equal(result.fallbackReasonCode, "stepcode.community.noAtomicPreempt");
});

test("不带降级标记的 inputAccepted ACK：字段无键（additive optional，不强制旧发送端）", () => {
  const parsed = commandAckSchema.parse(
    ackWire({
      type: "inputAccepted",
      delivery: "startNow",
      inputId: "cmd-r3h-ack",
    }),
  );
  const result = parsed.result;
  assert.ok(result?.type === "inputAccepted");
  assert.equal(
    "fallbackReasonCode" in result,
    false,
    "idle 直发等无降级场景 ACK 不得凭空长出该键（防声明被误改成 required/带默认值）",
  );
});
