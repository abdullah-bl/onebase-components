// Shared test setup for the component packages. `Runtime` and `startApp` are not in
// onebase's package exports, so we reach into the linked checkout once here; packages
// import from this helper (`../../test/app`) rather than deep paths themselves.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDriver, type Driver } from "../node_modules/onebase/src/engine/driver";
import { Runtime, type RuntimeOptions } from "../node_modules/onebase/src/engine/runtime";
import { startApp } from "../node_modules/onebase/src/app";
import { defineSchema } from "onebase/server";

export const quiet = { info() {}, warn() {}, error() {} };

export type TestApp = {
  runtime: Runtime;
  driver: Driver;
  dir: string;
  close: () => Promise<void>;
};

/** A onebase runtime on a fresh SQLite database, with components mounted and an empty app schema. */
export async function openRuntime(opts: Partial<Omit<RuntimeOptions, "driver" | "log">> = {}): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), "onebase-components-"));
  const driver: Driver = new SqliteDriver(`${dir}/db.sqlite`);
  const { schema = defineSchema({}), modules = {}, ...rest } = opts;
  const runtime = new Runtime({ driver, log: quiet, schema, modules, ...rest } as RuntimeOptions);
  try {
    await runtime.init();
  } catch (err) {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    runtime,
    driver,
    dir,
    close: async () => {
      runtime.stop();
      await driver.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Calls a component function as a client would: `call(app, "g:hello", args, identity?)`. */
export function call(app: TestApp, fn: string, args: object, identity?: { subject: string; tokenIdentifier: string }) {
  return app.runtime.runQuery(`components/${fn}`, args, { identity });
}

/** Mutates through a component function as a client would. */
export function callMutation(app: TestApp, fn: string, args: object, identity?: { subject: string; tokenIdentifier: string }) {
  return app.runtime.runMutation(`components/${fn}`, args, { identity });
}

export { startApp };

// onebase's engine uses bare `Transferable` in worker postMessage calls. bun-types
// only declares it under its `Bun` namespace and @types/node module-scoped, so give
// the typecheck a global alias here, where every package's program picks it up.
declare global {
  type Transferable = ArrayBuffer | MessagePort;
}
