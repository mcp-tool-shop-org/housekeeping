// Which org a checkout audits, and which of its repos are not products.
//
// The rules do not depend on whose org they read, so the org's name and its
// exemptions live in a file beside the code, never in the code. The file is
// optional: without one, the org is given on the command line and only the
// `.github` repo -- which exists to hold org-wide defaults in any org -- is
// treated as a non-product.
//
//   housekeeping.config.json
//   { "org": "your-org", "metaRepos": [".github", "design-assets"] }
//
// No network and no database here, so every branch is unit-testable.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userError } from './errors.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = process.env.HK_CONFIG ?? join(ROOT, 'housekeeping.config.json');

const KEYS = ['org', 'metaRepos'];
const invalid = message => userError('CONFIG_INVALID', message,
  'fix housekeeping.config.json; housekeeping.config.example.json shows the shape');
const DEFAULT_META = ['.github'];

/**
 * Parse config text. Pure. Every malformed shape THROWS rather than falling
 * back to a default: `metaRepos` suppresses hygiene findings, so a typo that
 * silently emptied it would file findings against repos that are exempt, and a
 * typo in the key name (`metaRepo`) would do the same while looking configured.
 */
export function parseConfig(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { throw invalid(`housekeeping config is not valid JSON: ${e.message}`); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('housekeeping config must be a JSON object');
  }
  const unknown = Object.keys(raw).filter(k => !KEYS.includes(k));
  if (unknown.length) {
    throw invalid(`housekeeping config has unknown key(s): ${unknown.join(', ')} (known: ${KEYS.join(', ')})`);
  }
  const org = raw.org ?? null;
  if (org !== null && (typeof org !== 'string' || !org.trim())) {
    throw invalid('housekeeping config: "org" must be a non-empty string');
  }
  const meta = raw.metaRepos ?? DEFAULT_META;
  if (!Array.isArray(meta) || meta.some(m => typeof m !== 'string' || !m.trim())) {
    throw invalid('housekeeping config: "metaRepos" must be an array of repo names');
  }
  return { org, metaRepos: [...meta] };
}

/** Read the config file. A missing file is the defaults; an unreadable or malformed one throws. */
export function loadConfig(path = CONFIG_PATH) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { org: null, metaRepos: [...DEFAULT_META] };
    throw e;
  }
  return parseConfig(text);
}

/**
 * The org a sweep should collect: the command-line argument, else the config.
 * Throws when neither names one -- a sweep must never guess whose org to read.
 */
export function resolveOrg(arg, config = loadConfig()) {
  const org = arg ?? config.org;
  if (!org) {
    throw userError('NO_ORG', 'no org given',
      'pass one (hk refresh <org>) or set "org" in housekeeping.config.json');
  }
  return org;
}
