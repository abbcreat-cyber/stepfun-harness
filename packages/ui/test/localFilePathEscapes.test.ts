import test from "node:test";
import assert from "node:assert/strict";
import { decodeFilePathUriEscapes, encodeUriPathForFileUrl } from "../src/lib/path.js";

test("local URI paths decode filename punctuation without decoding separators or twice", () => {
  assert.equal(decodeFilePathUriEscapes("qa/%E4%B8%AD%E6%96%87%20%231.md", true), "qa/中文 #1.md");
  assert.equal(decodeFilePathUriEscapes("qa/a%26b%2Bc%3Dd.md", true), "qa/a&b+c=d.md");
  assert.equal(decodeFilePathUriEscapes("qa/literal%2523.md", true), "qa/literal%23.md");
  assert.equal(decodeFilePathUriEscapes(decodeFilePathUriEscapes("qa/literal%2523.md", true)), "qa/literal%23.md");
  assert.equal(decodeFilePathUriEscapes("qa/a%2Fb%5Cc.md", true), "qa/a%2Fb%5Cc.md");
  assert.equal(decodeFilePathUriEscapes("qa/invalid%zz.md", true), "qa/invalid%zz.md");
  const parsed = decodeFilePathUriEscapes("qa/literal%2523.md", true);
  assert.equal(decodeFilePathUriEscapes(encodeUriPathForFileUrl(parsed), true), "qa/literal%23.md");
});
