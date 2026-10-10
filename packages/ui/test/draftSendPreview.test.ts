import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleDraftSendPreview, shouldPreviewPendingSend, type DraftSendPreview } from "../src/v4/composer/draftSendPreview.js";

const pending: DraftSendPreview = { token: 1, workspaceKey: "one", generation: 3, text: "hello", attachmentCount: 0, sessionId: null, commandId: null };
test("已有空闲会话与首发立即反馈，排队和斜杠命令不伪装成新正文", () => {
  assert.equal(shouldPreviewPendingSend("hello", false, "startNow"), true);
  assert.equal(shouldPreviewPendingSend("hello", true), true);
  assert.equal(shouldPreviewPendingSend("hello", false, "queue"), false);
  assert.equal(shouldPreviewPendingSend(" /compact", true), false);
  assert.equal(shouldPreviewPendingSend("hello", false, "queue", "startNow"), true);
});
test("已有会话的预览不受草稿世代影响，只有同会话权威行可接替", () => {
  const value = { ...pending, sessionId: "saved", commandId: "send" };
  assert.equal(visibleDraftSendPreview(value, "one", 999, "saved", null), value);
  assert.equal(visibleDraftSendPreview(value, "one", 999, "other", null), null);
});
test("draft preview is visible before network response, scoped to the originating draft", () => {
  assert.equal(visibleDraftSendPreview(pending,"one",3,null,null),pending);
  assert.equal(visibleDraftSendPreview(pending,"two",3,null,null),null);
  assert.equal(visibleDraftSendPreview(pending,"one",4,null,null),null);
  assert.equal(visibleDraftSendPreview(pending,"one",3,"another",null),null);
});
test("ACK binding keeps preview during subscription, without leaking into other sessions", () => {
  const bound={...pending,sessionId:"real",commandId:"cmd"};
  assert.equal(visibleDraftSendPreview(bound,"one",3,"real",null),bound);
  assert.equal(visibleDraftSendPreview(bound,"one",3,"other",null),null);
});

test("only the authoritative row for this command replaces the preview", () => {
  const bound={...pending,sessionId:"real",commandId:"cmd"};
  const row={kind:"userInput" as const,rowId:1,turnId:"turn",createdAt:1,createdAtSeq:1,origin:"realUser" as const,text:"hello",sourceCommandId:"another"};
  assert.equal(visibleDraftSendPreview(bound,"one",3,"real",{sessionId:"real",rows:{window:[row]}}),bound);
  assert.equal(visibleDraftSendPreview(bound,"one",3,"real",{sessionId:"real",rows:{window:[{...row,sourceCommandId:"cmd"}]}}),null);
  assert.equal(visibleDraftSendPreview(bound,"one",3,"real",{sessionId:"other",rows:{window:[{...row,sourceCommandId:"cmd"}]}}),bound);
});
