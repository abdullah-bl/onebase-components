#!/usr/bin/env bun
// onebase-static deploy <dir> --url <site url> [--label <text>] [-j <n>]
// onebase-static rollback --url <site url> [--to <deploymentId>]
// onebase-static status --url <site url>
//
// The token comes from $ONEBASE_STATIC_TOKEN (the mount's deployToken); the URL may also
// come from $ONEBASE_STATIC_URL.

import { parseArgs } from "node:util";
import { deploySite, rollbackSite, siteStatus } from "../src/deploy";

const USAGE = `Usage:
  onebase-static deploy <dir> --url <site url> [--label <text>] [-j <concurrency>]
  onebase-static rollback --url <site url> [--to <deploymentId>]
  onebase-static status --url <site url>

Environment: ONEBASE_STATIC_TOKEN (required), ONEBASE_STATIC_URL (instead of --url).`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      label: { type: "string" },
      to: { type: "string" },
      concurrency: { type: "string", short: "j" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, dir] = positionals;
  if (values.help || !command) return console.log(USAGE);

  const url = values.url ?? process.env.ONEBASE_STATIC_URL;
  const token = process.env.ONEBASE_STATIC_TOKEN;
  if (!url) throw new Error("Pass --url <site url> or set ONEBASE_STATIC_URL.");
  if (!token) throw new Error("Set ONEBASE_STATIC_TOKEN to the mount's deployToken.");

  switch (command) {
    case "deploy": {
      if (!dir) throw new Error("deploy needs a directory: onebase-static deploy ./dist --url ...");
      const result = await deploySite({ url, token, dir, label: values.label, concurrency: values.concurrency ? Number(values.concurrency) : undefined, log: (l) => console.log(l) });
      console.log(`Live: ${url} (${result.uploaded}/${result.files} file contents uploaded)`);
      return;
    }
    case "rollback": {
      const dep = await rollbackSite({ url, token, deploymentId: values.to });
      console.log(`Rolled back to ${dep.deploymentId}${dep.label ? ` (${dep.label})` : ""}.`);
      return;
    }
    case "status":
      console.log(JSON.stringify(await siteStatus({ url, token }), null, 2));
      return;
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
