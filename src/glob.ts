import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface GlobOptions {
  cwd?: string;
  dot?: boolean;
  ignore?: string | string[];
}

export interface GlobMatch {
  path: string;       // relative path from cwd
  absolute: string;   // absolute filesystem path
  isDirectory: boolean;
  isSymlink: boolean;
}

export async function globWalk(
  pattern: string,
  options: GlobOptions = {},
): Promise<GlobMatch[]> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const dot = options.dot ?? false;
  const ignorePatterns = normalizeIgnore(options.ignore);

  const regex = globToRegex(pattern, dot);
  const ignoreRegexes = ignorePatterns.map((p) => globToRegex(p, true));

  const results: GlobMatch[] = [];
  await walkDir(cwd, '', regex, ignoreRegexes, dot, results);
  return results;
}

async function walkDir(
  base: string,
  rel: string,
  pattern: RegExp,
  ignoreRegexes: RegExp[],
  dot: boolean,
  results: GlobMatch[],
): Promise<void> {
  const fullPath = rel ? join(base, rel) : base;
  let entries;
  try {
    entries = await readdir(fullPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip dot files unless dot option is set
    if (!dot && entry.name.startsWith('.')) continue;

    const entryRel = rel ? rel + '/' + entry.name : entry.name;
    const entryAbs = join(base, entryRel);

    // Check ignore patterns
    if (ignoreRegexes.some((r) => r.test(entryRel))) continue;

    const isDir = entry.isDirectory();
    const isSym = entry.isSymbolicLink();

    // Test against pattern
    const testPath = isDir ? entryRel + '/' : entryRel;
    if (pattern.test(entryRel) || (isDir && pattern.test(testPath))) {
      results.push({
        path: entryRel,
        absolute: entryAbs,
        isDirectory: isDir,
        isSymlink: isSym,
      });
    }

    // Recurse into directories
    if (isDir) {
      await walkDir(base, entryRel, pattern, ignoreRegexes, dot, results);
    }
  }
}

function normalizeIgnore(ignore: string | string[] | undefined): string[] {
  if (!ignore) return [];
  return Array.isArray(ignore) ? ignore : [ignore];
}

// Convert a glob pattern to a RegExp
export function globToRegex(pattern: string, dot: boolean): RegExp {
  let result = '';
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** — match any path segments
        if (pattern[i + 2] === '/') {
          result += '(?:.+/)?';
          i += 3;
        } else {
          result += '.*';
          i += 2;
        }
      } else {
        // * — match any chars except /
        result += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      result += '[^/]';
      i++;
    } else if (c === '[') {
      // Character class
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        result += '\\[';
        i++;
      } else {
        const cls = pattern.slice(i, end + 1);
        result += cls;
        i = end + 1;
      }
    } else if (c === '{') {
      // Brace expansion {a,b,c}
      const end = pattern.indexOf('}', i + 1);
      if (end === -1) {
        result += '\\{';
        i++;
      } else {
        const alternatives = pattern.slice(i + 1, end).split(',');
        result += '(?:' + alternatives.map(escapeRegex).join('|') + ')';
        i = end + 1;
      }
    } else if (c === '.') {
      result += '\\.';
      i++;
    } else if (c === '(' || c === ')' || c === '+' || c === '^' || c === '$' || c === '|') {
      result += '\\' + c;
      i++;
    } else {
      result += c;
      i++;
    }
  }

  return new RegExp('^' + result + '$');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
