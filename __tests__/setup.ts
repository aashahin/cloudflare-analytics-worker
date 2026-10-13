// Bun has no `cloudflare:workers` runtime module. The Worker only extends
// `WorkerEntrypoint`, whose runtime contract is "constructed with (ctx, env)".
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({
  WorkerEntrypoint: class WorkerEntrypoint<Env> {
    constructor(
      protected readonly ctx: unknown,
      protected readonly env: Env,
    ) {}
  },
}));
