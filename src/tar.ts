// TAR format module — streaming TAR writer
// Placeholder — full implementation in Phase 3

export class TarArchiveEntry {
  name = '';
  size = 0;
  mode = 0o100644;
  uid = 0;
  gid = 0;
  mtime = new Date();
  type = '0'; // normal file
  linkname = '';
  uname = '';
  gname = '';
}

export class TarArchiveOutputStream {
  // Placeholder — full implementation in Phase 3
}
