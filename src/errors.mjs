// The one shape an error leaves this tool in, for the CLI and the MCP server.
//
//   { code, message, hint, retryable, cause? }
//
// A message says what happened; a hint says what to do about it. A stack trace
// is for the person debugging the tool, not the person using it, so it is
// printed only on request (--debug).
//
// Exit codes:
//   0  ok
//   1  user error     the command, its arguments or the config file are wrong
//   2  runtime error  GitHub, the database or the disk failed; retry or repair
//   3  partial        the command finished, and part of what it was asked for
//                     is missing (a sweep with collection errors, or a cost
//                     pass that ran out of budget)
export const EXIT = Object.freeze({ OK: 0, USER: 1, RUNTIME: 2, PARTIAL: 3 });

export class HkError extends Error {
  constructor(code, message, { hint = null, cause, retryable = false, exit = EXIT.RUNTIME } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HkError';
    this.code = code;
    this.hint = hint;
    this.retryable = retryable;
    this.exit = exit;
  }
}

/** A mistake in how the tool was invoked or configured. Never retryable as-is. */
export const userError = (code, message, hint = null) =>
  new HkError(code, message, { hint, exit: EXIT.USER });

/** Any thrown value as the structured shape. Pure. */
export function structured(e) {
  if (e instanceof HkError) {
    const out = { code: e.code, message: e.message, hint: e.hint, retryable: e.retryable };
    if (e.cause !== undefined) out.cause = String(e.cause?.message ?? e.cause);
    return out;
  }
  // gh.mjs throws its own class for throttling; it predates this module and
  // carries the facts a hint needs.
  if (e?.isRateLimit) {
    return {
      code: 'RATE_LIMITED',
      message: e.message,
      hint: e.kind === 'primary'
        ? 'the hourly quota is spent; wait for it to reset'
        : 'a burst limit, not the quota; retry in a few minutes with fewer concurrent callers',
      retryable: true,
    };
  }
  return {
    code: 'UNEXPECTED',
    message: String(e?.message ?? e),
    hint: 're-run with --debug for the stack trace',
    retryable: false,
  };
}

/** The process exit code for a thrown value. Anything unclassified is a runtime error. */
export function exitCodeFor(e) {
  return e instanceof HkError ? e.exit : EXIT.RUNTIME;
}

/** Lines for stderr. The stack appears only with `debug`. Pure. */
export function formatError(e, { debug = false } = {}) {
  const s = structured(e);
  const lines = [`error [${s.code}] ${s.message}`];
  if (s.cause) lines.push(`cause: ${s.cause}`);
  if (s.hint) lines.push(`hint: ${s.hint}`);
  if (s.retryable) lines.push('retryable: yes');
  if (debug && e?.stack) lines.push('', e.stack);
  return lines.join('\n');
}

/**
 * Admit one read-only statement, or refuse. Returns the statement to run.
 * Shared by `hk sql` and the MCP `hk_sql` tool so the two cannot disagree
 * about what "read-only" means.
 */
export function readOnlyQuery(query) {
  const q = String(query ?? '').trim().replace(/;\s*$/, '');
  if (!q) throw userError('USAGE', 'no query given', 'hk sql "SELECT ..."');
  if (!/^(select|with)\b/i.test(q)) {
    throw userError('SQL_REFUSED', 'only SELECT and WITH statements are allowed',
      'the warehouse is derived data; change it by loading a snapshot, not by SQL');
  }
  if (/;/.test(q)) throw userError('SQL_REFUSED', 'multiple statements are not allowed', 'send one statement');
  return q;
}

/**
 * Did a sweep finish with part of its work missing? Returns the reasons, which
 * is empty for a complete sweep. Pure.
 */
export function sweepGaps(snapshot) {
  const gaps = [];
  const errors = snapshot?.errors?.length ?? 0;
  if (errors) gaps.push(`${errors} collection error(s) recorded`);
  if (snapshot?.run_costs?.budget_hit) gaps.push('the cost pass ran out of budget; cost attribution is incomplete');
  return gaps;
}
