# arkiv — Implementation Plan

## Overview

**arkiv** is a modern, zero-dependency, TypeScript-first replacement for
[archiver](https://github.com/archiverjs/node-archiver) (17.7M weekly npm
downloads, single maintainer, no npm release in 2 years, inactive maintenance,
open bugs unfixed, no drop-in replacement).

arkiv provides a 100% archiver-compatible API so existing code can migrate with
a single import path change.

**npm package:** `@agentine/arkiv`
**License:** MIT

---

## Why archiver Needs Replacing

| Signal | Detail |
|---|---|
| Downloads | 17.7M weekly / 77M+ monthly |
| Dependents | 6,153 npm packages |
| Maintainer | Single maintainer (ctalkington) |
| Last release | v7.0.1 — March 10, 2024 (2 years ago) |
| Maintenance | INACTIVE per Snyk |
| Open issues | 80+ (including bugs like finalize promise resolving before files are written) |
| Dependencies | 6 runtime deps including unmaintained `async` (caolan) and `buffer-crc32` |
| Source language | JavaScript (no TypeScript types) |
| API style | Callback/event-based, no native Promise support |
| Missing features | No async/await, no built-in progress reporting, memory issues with large directories |

**No API-compatible replacement exists.** adm-zip is in-memory (different API).
jszip is browser-focused (different API). tar (isaacs) is TAR-only with a
different API. None match archiver's streaming pipeline interface.

---

## Design Principles

1. **Drop-in compatible** — same exports, same methods, same events, same output
2. **TypeScript-first** — full type safety, generics, strict mode
3. **Zero dependencies** — built-in CRC32, ZIP writer, TAR writer, glob walker
4. **Promise-native** — `finalize()` returns a proper Promise; events still supported
5. **Memory efficient** — streaming by default, no buffering entire archives
6. **ESM + CJS** — dual-publish for all environments
7. **Node.js 18+** — modern baseline (LTS)

---

## Architecture

### Core Components

```
arkiv(format, options)
  ├── Archiver (core engine, extends Transform stream)
  │     ├── append(source, data)      — add stream/buffer/string
  │     ├── file(filepath, data)      — add file by path
  │     ├── directory(dirpath, dest)  — add directory recursively
  │     ├── glob(pattern, opts, data) — add files matching glob
  │     ├── finalize()                — seal archive (returns Promise)
  │     ├── abort()                   — cancel archive
  │     └── pointer()                 — bytes written
  │
  ├── ZipModule (ZIP format handler)
  │     ├── ZipArchiveEntry
  │     ├── ZipArchiveOutputStream (streaming ZIP writer)
  │     ├── CRC32 (built-in, no dependency)
  │     └── Deflate via Node.js zlib
  │
  ├── TarModule (TAR format handler)
  │     ├── TarArchiveEntry
  │     ├── TarArchiveOutputStream (streaming TAR writer)
  │     └── Optional gzip via Node.js zlib
  │
  └── GlobWalker (built-in directory/glob traversal)
```

### Format Modules

- **ZIP:** PKZIP 2.0 spec. Store (no compression) and Deflate methods. ZIP64
  extensions for files >4GB. Streaming output with proper central directory.
- **TAR:** POSIX.1-2001 (pax) format. ustar headers with pax extended headers
  for long paths and large files. Optional gzip wrapper.

### Compatibility Layer

`arkiv/compat/archiver` provides a module-replacement alias:
```js
// Before:
import archiver from 'archiver';
// After:
import archiver from '@agentine/arkiv/compat/archiver';
// Or just:
import archiver from '@agentine/arkiv';
```

The default export IS the archiver-compatible factory function, so most code
works with zero changes beyond the import path.

---

## API Surface

### Factory Function

```ts
import arkiv from '@agentine/arkiv';

const archive = arkiv('zip', { zlib: { level: 9 } });
const archive = arkiv('tar', { gzip: true });
```

### Core Methods

| Method | Description |
|---|---|
| `archive.append(source, data)` | Append stream, Buffer, or string |
| `archive.file(filepath, data)` | Append file from filesystem |
| `archive.directory(dirpath, destpath?, data?)` | Append directory recursively |
| `archive.glob(pattern, options?, data?)` | Append files matching glob |
| `archive.symlink(filepath, target, mode?)` | Add symlink entry |
| `archive.pipe(destination)` | Pipe output to writable stream |
| `archive.finalize()` | Seal archive and flush (returns Promise) |
| `archive.abort()` | Cancel archive creation |
| `archive.pointer()` | Total bytes emitted so far |
| `archive.setFormat(format)` | Set archive format |
| `archive.setModule(module)` | Register custom format module |

### Events

| Event | Payload |
|---|---|
| `error` | Error object |
| `warning` | Error object (non-fatal) |
| `entry` | Entry data object |
| `progress` | `{ entries: { total, processed }, fs: { totalBytes, processedBytes } }` |
| `close` | (none) |
| `end` | (none) |
| `drain` | (none) |

### ZIP Options

| Option | Default | Description |
|---|---|---|
| `zlib.level` | 6 | Compression level (0-9) |
| `store` | false | Store without compression |
| `comment` | '' | Archive comment |
| `forceLocalTime` | false | Use local time in headers |
| `forceZip64` | false | Always use ZIP64 extensions |
| `namePrependSlash` | false | Prepend / to entry names |
| `statConcurrency` | 4 | Concurrent stat operations |

### TAR Options

| Option | Default | Description |
|---|---|---|
| `gzip` | false | Apply gzip wrapper |
| `gzipOptions` | {} | Passed to zlib.createGzip |
| `statConcurrency` | 4 | Concurrent stat operations |

---

## Implementation Tasks

### Phase 1: Project Scaffolding
- TypeScript project setup (ESM + CJS dual build)
- Package.json with correct exports map
- CI/CD configuration
- Test framework setup

### Phase 2: CRC32 + ZIP Writer
- Built-in CRC32 implementation (table-based)
- ZIP local file header / data descriptor / central directory writing
- Deflate compression via Node.js zlib
- Store (no compression) mode
- ZIP64 extensions for large files
- Streaming output (no buffering entire archive)

### Phase 3: TAR Writer
- TAR ustar header generation
- PAX extended headers for long paths / large files
- Optional gzip wrapper
- Streaming output

### Phase 4: Core Archiver Engine
- Transform stream base class
- `append()`, `file()`, `directory()`, `glob()`, `symlink()` methods
- Entry queue with concurrency control
- `finalize()` with proper Promise resolution
- `abort()` cleanup
- `pointer()` byte tracking
- Event emission (error, warning, entry, progress, close)
- `statConcurrency` option for parallel fs.stat calls

### Phase 5: Compatibility Layer + Tests
- `arkiv/compat/archiver` drop-in module
- archiver test suite port (verify output compatibility)
- Edge cases: empty archives, large files (>4GB), long paths (>255 chars)
- Symlink handling
- Memory usage benchmarks
- Cross-platform tests (Windows path handling)

---

## Deliverables

- `@agentine/arkiv` npm package
- Zero runtime dependencies
- TypeScript types included
- ESM + CJS dual package
- Drop-in archiver compatibility layer
- Comprehensive test suite
- README with migration guide
