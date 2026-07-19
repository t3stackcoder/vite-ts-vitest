# Generic Abstract Factory Harness

A strict TypeScript/Vite/Zod example of lazy factory discovery with
`import.meta.glob`, a runtime-hardened registry, and schema-derived input/output
inference.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
```

The full design document — architecture, type system, resilience machinery,
event reference, error taxonomy, operator runbook, and evolution path — lives
in [docs/factory-kernel.md](docs/factory-kernel.md).

## Architecture

- `src/factory/` is reusable infrastructure with no aircraft-domain imports.
- `src/aircraft/catalog.ts` is the runtime Zod catalog and branded-key map.
- `src/aircraft/factories/` contains independently loadable factory modules.
- `src/aircraft/registry.ts` is the Vite composition root containing the
  literal `import.meta.glob()` call.

Vite must see a literal glob pattern at the call site. The harness therefore
accepts Vite's loader map instead of trying to accept a runtime glob string.

## Adding a factory

1. Create a branded key from your domain's namespace builder, e.g.
   `aircraft.key('cargo-drone')` (see `factoryNamespace()`); the
   "namespace:name" format is composed by the type system, never typed by
   hand.
2. Define Zod schemas for the factory context and product family.
3. Add them with `factoryContract()` and `factoryCatalogEntry()`.
4. Map the module filename stem to the key.
5. Default-export a factory created by `defineFactoryFor<Catalog>()`.
6. Add the matching `*.factory.ts` file; the composition root needs no new
   import or registration statement.

The loader remains fully typed from Vite through `FactorySource`:

```ts
import.meta.glob<CatalogFactoryModule<Catalog>>('./factories/*.factory.ts')
// FactorySource.load(): Promise<CatalogFactoryModule<Catalog>>
```

Zod independently parses the runtime module boundary. The catalog's context
schema parses data before the chunk loads, and its result schema parses the
factory output before the caller receives it. Registry input types use
`z.input`; factory implementations and returned products use `z.output`.

## Registry behavior

The registry provides lazy loading, one shared promise for concurrent loads,
factory and alias collision checks, path/exported-key agreement, semantic
metadata validation, Zod context/result validation, cached failures with
explicit invalidation, abort signals, `tryCreate()`, preload reports, and
immutable diagnostic snapshots.

- **Events.** An optional `onEvent` listener receives push notifications for
  operational transitions (loads, circuit opens/closes/probes, creation
  outcomes with correlation ids, operator resets). Unlike `snapshot()`
  polling, events capture transitions that have already resolved by the time
  anyone polls. A throwing listener never affects registry behavior.
- **Per-factory policies.** `policies` overrides `creationTimeoutMs`,
  `maxConcurrentCreations`, and circuit-breaker settings per factory key, so
  factories with different risk profiles (a slow external dependency next to
  pure computation) share one registry without sharing one budget. Unknown
  keys or invalid values fail closed with `INVALID_POLICY`.
- **Curated exports.** `src/factory/index.ts` re-exports the supported public
  surface explicitly; internal schemas and helpers are not part of the
  contract. A public-API test pins the export list so surface changes are
  deliberate.

## Hardening controls

- The public API exposes validated `create()` results, never a raw factory or
  module export. After validation, the registry captures `create` against an
  immutable receiver containing only the validated key and metadata.
- Execution options are strict Zod-validated data. Module loads default to a
  15-second deadline; creations default to 30 seconds and can override that
  deadline per call with `timeoutMs`.
- Every creation receives a registry-owned `AbortSignal`. A caller signal is
  linked to it, and a deadline aborts it for cooperative cleanup.
- Each factory has a concurrency bulkhead (16 active creations by default).
  Timed-out work retains its slot until the underlying promise actually
  settles, preventing uncooperative work from accumulating without bound.
  `resetConcurrency()` reclaims slots leaked by work that will never settle.
- Each factory has a closed/open/half-open circuit breaker (three consecutive
  failures and a 30-second reset window by default). Exactly one half-open
  probe is admitted; a probe that ends neutrally (for example, a caller
  abort) re-arms the circuit so the next creation probes again immediately.
  `resetCircuit()` provides an explicit operator reset.
- A caller's abort signal is honored while a module chunk is still loading:
  that caller rejects immediately while the shared load continues for others.
- `snapshot()` reports load state, active creation count, circuit state, and
  stable error codes without exposing executable plugin objects.

All defaults are configurable through `factoryHarnessFor()` or
`SmartFactoryRegistry`. Invalid policy values and per-call execution options
fail closed.

## Trust boundary

The glob itself is generic and stays typed as
`CatalogFactoryModule<Catalog>`—it is not widened to `unknown`. `unknown` is
used only where it belongs: caught errors and deliberately untrusted values at
runtime-validation boundaries.

Zod validates a module only after JavaScript has imported it, so module
top-level code has already executed. In-process deadlines also cannot preempt
an infinite synchronous loop or undo side effects. Treat this harness as a
hardened boundary for trusted or semi-trusted application modules. Truly
hostile plugins require a Worker, iframe, or separate process plus a serialized
message contract; that is a different execution architecture from
`import.meta.glob()` in the host realm.
