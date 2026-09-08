/**
 * The argument list a `pnpm --filter <pkg> <script> -- --flag` invocation meant.
 *
 * pnpm 9 forwards the `--` separator itself, so `process.argv` arrives as
 * `["--", "--email", "someone@example.com"]`. Node's `parseArgs` treats
 * everything after a `--` as positional, so it then refuses the flags with
 * `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL` and the documented command in the
 * README simply does not run.
 *
 * Found by running the command in the README rather than by reading it. Both
 * forms work from here on, because a script that only accepts one of them is a
 * script whose documentation is wrong for somebody.
 */
export function cliArgs(argv: string[] = process.argv.slice(2)): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}
