// Where housekeeping reads its own files and where it writes yours.
//
// Two kinds of path, kept apart on purpose:
//
//   PACKAGE_ROOT  what ships inside the package: src/schema.sql, package.json.
//                 Always relative to this file.
//   WORK_DIR      what a sweep writes and reads back: data/ (snapshots, the
//                 database, the caches, the sweep log), reports/, and
//                 housekeeping.config.json.
//
// WORK_DIR is HK_HOME when it is set. Otherwise it is the package root when
// housekeeping runs from a git checkout -- a clone, or `npm link` of one --
// which is how it has always behaved; and the current directory when it runs
// from an installed package, the way git and npm themselves work. Writing into
// an installed package would put a warehouse inside node_modules, where it can
// be read-only and where the next upgrade deletes it.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The directory housekeeping writes to. Pure given its inputs. */
export function workDir({ env = process.env, root = PACKAGE_ROOT, cwd = process.cwd(), exists = existsSync } = {}) {
  if (env.HK_HOME) return resolve(env.HK_HOME);
  return exists(join(root, '.git')) ? root : cwd;
}

export const WORK_DIR = workDir();
export const DATA_DIR = join(WORK_DIR, 'data');
export const REPORTS_DIR = join(WORK_DIR, 'reports');
