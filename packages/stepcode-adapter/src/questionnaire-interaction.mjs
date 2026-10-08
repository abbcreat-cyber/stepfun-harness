import { randomUUID } from "node:crypto";
import { clarificationResult, decodeQuestionnaire } from "./desktop-questionnaire.mjs";

/** 复用会话 worker 的 pending Map；此模块只装配请求和原协议答案，不持有第二份交互状态。 */
export function askDesktopQuestionnaire({ sessionId, request, signal, pending, options }) {
  const questionnaire = decodeQuestionnaire(request);
  if (!questionnaire) return null;
  const { toolCallId, questions } = questionnaire;
  return new Promise((resolve) => {
    const interactionId = `step-question-${randomUUID()}`;
    const row = options
      .rows(sessionId)
      .find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId);
    const abort = () => {
      pending.delete(interactionId);
      resolve({ cancelled: true });
      options.changed(sessionId);
    };
    pending.set(interactionId, {
      sessionId,
      valueKind: "questionnaire",
      validate(answer) {
        clarificationResult(questions, answer);
      },
      resolve(answer) {
        signal?.removeEventListener("abort", abort);
        resolve(answer?.action ? { value: JSON.stringify(answer) } : { cancelled: true });
      },
      item: {
        interactionId,
        kind: "userInput",
        anchorRowId: row?.rowId ?? null,
        createdAt: Date.now(),
        payload: {
          kind: "userInput",
          toolName: "AskUserQuestion",
          toolCallId,
          prompt: questions[0].question,
          freeText: true,
          questions,
          input: { questions },
          currentQuestionIndex: 0,
        },
      },
    });
    signal?.addEventListener("abort", abort, { once: true });
    options.changed(sessionId);
  });
}
