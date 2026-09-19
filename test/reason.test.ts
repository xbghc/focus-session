import { test } from "node:test";
import assert from "node:assert/strict";
import { reasonOf } from "../src/lib/reason.ts";

test("给人看的失败原因不带 Error: 前缀，也不会是 [object Object]", () => {
  assert.equal(reasonOf(new Error("后台未就绪")), "后台未就绪");
  assert.equal(reasonOf(new TypeError("")), "TypeError");
  assert.equal(reasonOf("直接抛出来的字符串"), "直接抛出来的字符串");
  assert.equal(reasonOf({ message: "消息端口已关闭" }), "消息端口已关闭");
  assert.equal(reasonOf({ code: 7 }), "未知错误");
  assert.equal(reasonOf(undefined), "未知错误");
});
