import { fileURLToPath } from "node:url";

export const QUESTIONNAIRE_PREFIX = "stepcode:questionnaire:v1:";
const MAX_ENVELOPE = 65536;

export function normalizeClarification(input = {}) {
  const raw = Array.isArray(input.questions) ? input.questions : input.question ? [input] : [];
  if (!raw.length || raw.length > 12) throw new Error("提问需要 1–12 个问题");
  return raw.map((question, index) => {
    const text = String(question.question ?? question.prompt ?? "").trim();
    if (!text) throw new Error("问题正文不能为空");
    const options = (Array.isArray(question.options) ? question.options : [])
      .slice(0, 8)
      .map((option) => {
        const label = typeof option === "string" ? option : option.label;
        if (typeof label !== "string" || !label.trim()) throw new Error("问题选项缺少名称");
        return {
          value: String(typeof option === "string" ? option : (option.value ?? option.id ?? label)),
          label,
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        };
      });
    if (question.allow_freeform === false && !options.length)
      throw new Error("禁止自由输入时必须提供选项");
    return {
      id: String(question.id ?? `q${index + 1}`),
      question: text,
      header: String(question.label ?? question.header ?? `问题 ${index + 1}`),
      options,
      allowFreeform: question.allow_freeform !== false,
      ...(typeof question.reason === "string" ? { reason: question.reason } : {}),
      ...(question.multiSelect === true || question.multiple === true ? { multiSelect: true } : {}),
    };
  });
}

export function encodeQuestionnaire(toolCallId, input) {
  const text =
    QUESTIONNAIRE_PREFIX + JSON.stringify({ toolCallId, questions: normalizeClarification(input) });
  if (text.length > MAX_ENVELOPE) throw new Error("交互问题内容过大");
  return text;
}

export function decodeQuestionnaire(request) {
  if (request.method !== "input" || !request.title?.startsWith(QUESTIONNAIRE_PREFIX)) return null;
  if (request.title.length > MAX_ENVELOPE) throw new Error("交互问题内容过大");
  const envelope = JSON.parse(request.title.slice(QUESTIONNAIRE_PREFIX.length));
  if (typeof envelope.toolCallId !== "string" || !envelope.toolCallId)
    throw new Error("提问缺少工具标识");
  return {
    toolCallId: envelope.toolCallId,
    questions: normalizeClarification({
      questions: envelope.questions.map((q) => ({
        ...q,
        label: q.header,
        allow_freeform: q.allowFreeform,
      })),
    }),
  };
}

export function clarificationResult(questions, reply) {
  const cancelled = !reply || reply.action !== "accept";
  const nativeAnswers = [],
    answers = {};
  if (!cancelled)
    for (const [index, question] of questions.entries()) {
      const raw =
        reply.content?.[`answer_${index}`] ??
        (questions.length === 1 ? reply.content?.answer : undefined);
      if (raw === undefined) continue;
      const values = Array.isArray(raw) ? raw : [raw];
      if (!question.multiSelect && values.length > 1) throw new Error("单选问题不能提交多个答案");
      const selected = values
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => {
          const option = question.options.find((option) => option.value === value);
          if (!option && !question.allowFreeform) throw new Error("答案不属于可选项");
          return { value, label: option?.label ?? value, wasCustom: !option };
        });
      if (!selected.length) continue;
      nativeAnswers.push({
        id: question.id,
        value: selected.map((a) => a.value).join(", "),
        label: selected.map((a) => a.label).join(", "),
        wasCustom: selected.some((a) => a.wasCustom),
      });
      const display = selected.map((a) => a.label).join(", ");
      // 原生允许同题干不同 id；稳定 id 才能防止两项答案在回显时互相覆盖。
      answers[question.id] = display;
      if (
        questions.filter((item) => item.question === question.question).length === 1 &&
        !questions.some((item) => item.id === question.question && item.id !== question.id)
      ) answers[question.question] = display;
    }
  return {
    content: [{ type: "text", text: JSON.stringify({ answers, nativeAnswers, cancelled }) }],
    details: { questions, answers: nativeAnswers, cancelled },
    isError: false,
  };
}

export function withDesktopQuestionnaire(command) {
  if (!Array.isArray(command) || !command.length) return command;
  const isStep = command.some(
    (arg) =>
      /(?:^|[/\\])step(?:\.exe|\.js)?$/i.test(arg) ||
      /[/\\]apps[/\\]cli[/\\]dist[/\\]main\.js$/i.test(arg),
  );
  const extension = fileURLToPath(
    new URL("./extensions/desktop-questionnaire.mjs", import.meta.url),
  );
  if (!isStep) return command;
  const next = [...command];
  if (!next.includes(extension)) next.push("--extension", extension);
  // 底座将未知扩展工具默认当作可写操作；clarify_user 仅收集答案，不能先弹一次执行授权。
  // 仍保留调用者显式设置的 allow/confirm/deny，不扩大其他工具的权限。
  if (!next.some((arg) => /(?:^|=)clarify_user=(?:allow|confirm|deny)$/.test(arg)))
    next.push("--tool-override", "clarify_user=allow");
  return next;
}
