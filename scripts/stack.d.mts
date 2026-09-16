/**
 * Types for the two pure functions `stack-deploy.test.ts` imports (D174).
 *
 * `scripts/` is plain JavaScript run by node with no build step, which is
 * deliberate: a deploy tool that needs compiling is a deploy tool that can fail
 * to compile at the moment you need it. TypeScript therefore has nothing to go
 * on when a test imports from it, and this is the smallest thing that fixes
 * that.
 *
 * **Only what is imported.** Everything else in the script is driven as a
 * subprocess and needs no declaration, and a full description of the module
 * would be a second copy of it, free to drift.
 */
export type StackVariable = { name: string; value: string };

export function nextVariables(
  current: StackVariable[],
  options: { repo: string; version: string; set?: Record<string, string>; unset?: string[] },
): StackVariable[];

export function assertNothingDropped(
  current: StackVariable[],
  next: StackVariable[],
  unset?: string[],
): StackVariable[];

export function isSecretName(name: string): boolean;
