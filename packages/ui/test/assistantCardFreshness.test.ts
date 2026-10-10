import test from "node:test";
import assert from "node:assert/strict";
import { resolveValidatedAssistantPreviewCards } from "../src/lib/assistantPreviewCardValidation.js";
import type { AssistantPreviewCard } from "../src/lib/assistantPreviewCards.js";
test("文件卡片去重路径并显式要求当前事实，网页不触发文件检查", async () => {
  const card: AssistantPreviewCard = {
    id: "one",
    type: "markdown",
    kind: "markdown",
    title: "report",
    subtitleId: "chat.previewCards.markdown",
    path: "D:/report.md",
  };
  let exists = true,
    calls = 0;
  const service = {
    async checkFilesExist(params: { paths: string[]; refresh?: boolean }) {
      calls++;
      assert.deepEqual(params, { paths: ["D:/report.md"], refresh: true });
      return params.paths.map((path) => ({ path, exists }));
    },
  };
  assert.equal(
    (await resolveValidatedAssistantPreviewCards([card, { ...card, id: "two" }], service)).length,
    2,
  );
  exists = false;
  assert.deepEqual(await resolveValidatedAssistantPreviewCards([card], service), []);
  assert.equal(calls, 2);
  const web: AssistantPreviewCard = {
    id: "web",
    type: "website",
    title: "local",
    subtitleId: "chat.previewCards.website",
    url: "http://localhost:3000",
  };
  assert.deepEqual(await resolveValidatedAssistantPreviewCards([web], service), [web]);
  assert.equal(calls, 2);
});
