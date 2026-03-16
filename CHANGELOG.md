# Changelog

## 0.1.0 — 2026-03-15

Initial release.

- Streaming ZIP writer with store, deflate, and ZIP64 support
- CRC32 table-based implementation
- Streaming TAR writer with ustar headers and PAX extensions
- Core Archiver engine with append/file/directory/glob/symlink methods
- Transform stream interface with Promise-based finalize()
- Event emission: error, warning, entry, progress
- Drop-in archiver compatibility layer (`@agentine/arkiv/compat/archiver`)
- TypeScript-first with full type declarations
- Zero dependencies
- ESM + CJS dual package
