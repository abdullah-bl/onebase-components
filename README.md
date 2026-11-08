# onebase-components

Optional, install-what-you-need components for [OneBase](../onebase). Each
component is its own package, so apps install and mount only what they use.
All packages follow the [onebase component model](../onebase/docs/components-authoring.md):
own tables, typed config, crons, HTTP routes, and no-codegen client exposure.

| Package | What it does |
| --- | --- |
| [`@onebase/teams`](packages/teams) | Teams with opt-in roles (`owner/admin/member` by default) |
| [`@onebase/app-store`](packages/app-store) | Apple App Store: JWS verification, Server Notifications V2 webhook, StoreKit 2 transaction sync, subscription state |
| [`@onebase/entitlements`](packages/entitlements) | Plans, limits, and usage; can be driven by app-store events |
| [`@onebase/push`](packages/push) | Push notifications: APNs and FCM, device registry, dead-token cleanup |
| [`@onebase/email`](packages/email) | Email transports (Resend, Postmark, SMTP) + onebase auth `sendCode` helper |
| [`@onebase/notifications`](packages/notifications) | In-app notification feed with live queries and an optional email channel |

`ui/` is reserved for UI component packages (`@onebase/ui-<name>`).

## Development

```sh
bun install          # links the checkout at ../onebase as the `onebase` dependency
bun test             # every package's tests, plus the harness smoke test
bun run typecheck    # tsc over the root test helper and every package
```

Packages ship their TypeScript source directly (no build step) — the same way
`onebase` itself is consumed, since bun runs TS natively. `onebase` is a peer
dependency; until it publishes to npm, this repo links the local checkout.

## Adding a component

1. `packages/<name>/` with a `package.json` (`exports: { ".": "./src/index.ts" }`),
   a `tsconfig.json` extending the base (`include: ["src", "test"]`), and
   `onebase` in `peerDependencies`.
2. Model `src/index.ts` on any package here: `defineSchema` the component's
   tables, `componentServer<DataModelFromSchema<typeof schema>, Config>()` for
   the function builders, `defineComponent`, then a `mount` factory with
   `splitMountOptions`.
3. Tests go in `test/` and mount the component through `../../../test/app`
   (`openRuntime` + `call`/`callMutation`), which runs a real onebase runtime
   on SQLite. The helper deep-imports `Runtime`/`startApp` from the linked
   checkout, since `onebase`'s package exports don't expose them.
4. `bun test` and `bun run typecheck` at the root pick the package up
   automatically.

## Publishing

Each package versions and publishes independently (`bun publish` inside the
package directory). Cross-package imports (e.g. entitlements → app-store) are
optional peer dependencies. Components themselves depend only on
`onebase/components`, `onebase/server`, and `onebase/values` at runtime.
