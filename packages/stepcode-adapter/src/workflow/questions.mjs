import { randomUUID } from "node:crypto";
import { decodeQuestionnaire, clarificationResult } from "../desktop-questionnaire.mjs";

/** 仅 workflow service 拥有问答等待；停止取消等待，权限确认仍走用户 UI。 */
export class WorkflowQuestions {
  constructor(service) {
    this.service = service;
    this.items = new Map();
  }
  list(runId) {
    return [...this.items.values()]
      .filter((x) => x.runId === runId && x.status === "pending")
      .map((x) => x.public);
  }
  ask(runId, actor, request, signal, origin) {
    if (request.method !== "input" && request.method !== "select")
      return (
        this.service.options.onUiRequest?.(request, signal) ?? Promise.resolve({ cancelled: true })
      );
    if (signal.aborted) return Promise.resolve({ cancelled: true });
    const questionnaire = decodeQuestionnaire(request);
    const qid = `dwfq-${randomUUID()}`;
    return new Promise((resolve) => {
      const item = {
        runId,
        status: "pending",
        request,
        questionnaire,
        public: {
          qid,
          question_id: qid,
          runId,
          actor,
          question: questionnaire?.questions ?? request.message ?? request.title,
          options: request.options,
        },
        finish: (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
      };
      const abort = () => {
        item.status = "cancelled";
        item.finish({ cancelled: true });
      };
      this.items.set(qid, item);
      signal.addEventListener("abort", abort, { once: true });
      this.service.options.onQuestion?.(item.public, origin);
    });
  }
  resolve(qid, answer) {
    const item = this.items.get(qid);
    if (!item) return { ok: false, reason: "unknown_question" };
    if (item.status !== "pending")
      return {
        ok: false,
        reason: item.status === "cancelled" ? "run_not_in_flight" : "already_resolved",
      };
    if (!this.service.active.has(item.runId)) return { ok: false, reason: "run_not_in_flight" };
    if (typeof answer !== "string" || !answer.trim()) throw new Error("答案不能为空");
    let response = { value: answer };
    if (item.questionnaire) {
      const reply = {
        action: "accept",
        content: Object.fromEntries(
          item.questionnaire.questions.map((_, i) => [`answer_${i}`, answer]),
        ),
      };
      clarificationResult(item.questionnaire.questions, reply);
      response = { value: JSON.stringify(reply) };
    } else if (item.request.method === "select" && !item.request.options?.includes(answer))
      throw new Error("答案不属于可选项");
    item.status = "answered";
    item.finish(response);
    return { ok: true, qid, response: "答案已交给子代理，工作流继续执行。" };
  }
}
