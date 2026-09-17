/**
 * Types for what `release.test.ts` imports (D182).
 *
 * `scripts/` is plain JavaScript run by node with no build step, which is
 * deliberate: a deploy tool that needs compiling is a deploy tool that can fail
 * to compile at the moment you need it. This is the smallest thing that lets a
 * TypeScript test import from it, and it declares **only what is imported**: a
 * full description of the module would be a second copy of it, free to drift.
 */

/** Where a command is run, so a test can answer as the world would. */
export type StepRunner = {
  dryRun: boolean;
  local(file: string, args: string[]): { code: number; out: string };
  remote(host: string, command: string): { code: number; out: string };
};

export type Handover =
  | { ok: false; why: string }
  | {
      ok: true;
      sets: { name: string; value: string }[];
      fromEnv: string[];
      commit: string | null;
    };

export type Step = {
  name: string;
  run(): { ok: true; evidence: string } | { ok: false; why: string; fix: string | null };
};

/** What STATE.md's "Inför nästa deploy" says this version needs. */
export function readHandover(state: string, version: string): Handover;

/** The version's Nyheter post, as a `# Title` and a body, or null. */
export function readNewsPost(state: string, version: string): string | null;

/** `stack.mjs`'s arguments for this version, from STATE.md's own list. */
export function stackArgs(
  version: string,
  handover: Extract<Handover, { ok: true }>,
  command: "plan" | "deploy",
): string[];

export function buildSteps(options: {
  version: string;
  runner: StepRunner;
  root?: string;
}): Step[];

export function release(options: {
  version: string;
  runner: StepRunner;
  out?: { write(text: string): unknown };
  root?: string;
}): Promise<{ ok: boolean; stoppedAt: number | null; step?: string }>;
