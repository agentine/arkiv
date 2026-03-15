// Built-in glob walker for directory traversal
// Placeholder — full implementation in Phase 4

import type { GlobOptions } from './types.js';

export class GlobWalker {
  private _pattern: string;
  private _options: GlobOptions;

  constructor(pattern: string, options: GlobOptions = {}) {
    this._pattern = pattern;
    this._options = options;
  }

  get pattern(): string {
    return this._pattern;
  }

  get options(): GlobOptions {
    return this._options;
  }
}
