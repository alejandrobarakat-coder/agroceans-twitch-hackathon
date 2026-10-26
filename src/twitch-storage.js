'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
class TwitchFault extends Error {
  constructor(category, status = null) { super(category); this.category = category; this.status = status; }
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function privateDirectory(directory, create = false) {
  if (create) { try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  const s = fs.lstatSync(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new TwitchFault('unsafe_storage');
}
function readPrivate(filename, max = 8 * 1024 * 1024) {
  privateDirectory(path.dirname(filename));
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o077) || s.nlink !== 1 || s.size > max) throw new TwitchFault('unsafe_storage');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
class TwitchStorage {
  constructor(directory) { this.directory = directory; }
  prepare() {
    const parent = path.dirname(this.directory);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
    const s = fs.lstatSync(parent);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o022)) throw new TwitchFault('unsafe_storage');
    privateDirectory(this.directory, true);
  }
  lease(name) {
    this.prepare();
    const filename = path.join(this.directory, `.${name}-lock`);
    try { fs.mkdirSync(filename, { mode: 0o700 }); } catch (e) {
      if (e.code === 'EEXIST') throw new TwitchFault('storage_busy'); throw new TwitchFault('storage_unavailable');
    }
    return () => fs.rmdirSync(filename);
  }
  transaction(fn) { const release = this.lease('state'); try { return fn(); } finally { release(); } }
  read(name, fallback = null) {
    try { return JSON.parse(readPrivate(path.join(this.directory, name))); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  }
  write(name, data) {
    const filename = path.join(this.directory, name), tmp = path.join(this.directory, `${crypto.randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, filename);
      const dir = fs.openSync(this.directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
}
module.exports = { TwitchStorage, TwitchFault, readPrivate, digest };
