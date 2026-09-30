// How much the tool says on stderr. stdout is for results only.
//
//   silent   errors only
//   normal   one line per pass of a sweep, and what was written (the default)
//   verbose  adds one line per GitHub call
//   debug    adds stack traces on errors
//
// Set with --quiet / --verbose / --debug on the CLI, or HK_LOG in the
// environment. Nothing logged at any level can hold a credential: the tool
// never reads one. Authentication belongs to `gh`.
import { userError } from './errors.mjs';

export const LEVELS = ['silent', 'normal', 'verbose', 'debug'];

/** The level a name stands for. An unknown name is an error, never a silent default. Pure. */
export function parseLevel(name) {
  if (name === undefined || name === null || name === '') return 'normal';
  const level = String(name).toLowerCase();
  if (!LEVELS.includes(level)) {
    throw userError('CONFIG_INVALID', `unknown log level "${name}"`, `HK_LOG must be one of: ${LEVELS.join(', ')}`);
  }
  return level;
}

/** The level CLI flags ask for; null when none is given. The loudest flag wins. Pure. */
export function levelFromFlags(flags) {
  if (flags.has('--debug')) return 'debug';
  if (flags.has('--verbose')) return 'verbose';
  if (flags.has('--quiet')) return 'silent';
  return null;
}

const rank = level => LEVELS.indexOf(level);
const current = () => parseLevel(process.env.HK_LOG);
export const setLevel = level => { process.env.HK_LOG = parseLevel(level); };
export const isDebug = () => current() === 'debug';

/** A `normal`-level line. */
export const info = (...a) => { if (rank(current()) >= rank('normal')) console.error(...a); };
/** A `verbose`-level line. */
export const verbose = (...a) => { if (rank(current()) >= rank('verbose')) console.error(...a); };
