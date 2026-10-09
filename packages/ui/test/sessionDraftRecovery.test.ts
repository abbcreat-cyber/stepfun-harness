import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverSessionDraftSelection } from "../src/v4/composer/sessionDraftRecovery.js";

test("restore missing model from the same session without losing draft text or options",()=>{
 const draft={text:"unsent",mode:"build" as const,updatedAt:123};
 const selection={providerId:"custom",modelId:"model",options:{reasoningLevel:"enabled"}};
 assert.deepEqual(recoverSessionDraftSelection(draft,{modelSelection:selection}),{...draft,modelSelection:selection});
});
test("keep explicit choices and truly empty sessions unchanged",()=>{
 const draft={text:"unsent",mode:"build" as const,updatedAt:123,modelSelection:{providerId:"mine",modelId:"chosen"}};
 assert.equal(recoverSessionDraftSelection(draft,{modelSelection:{providerId:"other",modelId:"other"}}),draft);
 const empty={text:"draft",updatedAt:123};assert.equal(recoverSessionDraftSelection(empty,{}),empty);
 assert.equal(recoverSessionDraftSelection(empty,null),empty);
});
