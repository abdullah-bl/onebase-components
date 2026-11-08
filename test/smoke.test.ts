// Harness check: a trivial component mounts into a real onebase runtime and answers calls.

import { describe, expect, test } from "bun:test";
import { componentServer, defineComponent, defineComponents } from "onebase/components";
import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";
import { call, openRuntime } from "./app";

const schema = defineSchema({ notes: defineTable({ text: v.string() }) });
const c = componentServer<any, {}>();
const hello = c.query({ args: { name: v.string() }, handler: (_ctx, { name }) => `hi ${name}` });
const greeter = defineComponent({ name: "greeter", schema, functions: { hello } });
const components = defineComponents({ g: greeter.mount({}, { expose: ["hello"] }) });

describe("test harness", () => {
  test("runs a component in a real runtime", async () => {
    const app = await openRuntime({ schema: defineSchema({}), modules: {}, components: components as any });
    try {
      expect((await call(app, "g:hello", { name: "onebase" })).value).toBe("hi onebase");
    } finally {
      await app.close();
    }
  });
});
