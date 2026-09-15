import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// One local writer. The signed transaction is fsynced before network submission.
export function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(temporary, 'w', 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temporary, file)
  const directory = fs.openSync(path.dirname(file), 'r')
  try {
    fs.fsyncSync(directory)
  } finally {
    fs.closeSync(directory)
  }
}

export class Store {
  constructor(directory) {
    this.directory = path.resolve(directory)
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.lock = path.join(this.directory, 'writer.lock')
    this.file = path.join(this.directory, 'state.json')
    this.keysFile = path.join(this.directory, 'wallets.json')
  }

  acquire() {
    let fd
    try {
      fd = fs.openSync(this.lock, 'wx', 0o600)
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error(`Writer lock exists: ${this.lock}. Check its PID before removing a stale lock.`)
      throw error
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname() }))
    fs.closeSync(fd)
    this.held = true
    try {
      this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null
      this.keys = fs.existsSync(this.keysFile) ? JSON.parse(fs.readFileSync(this.keysFile, 'utf8')) : null
    } catch (error) {
      this.release()
      throw error
    }
  }

  save() {
    if (!this.held) throw new Error('State write requires writer lock')
    atomicJson(this.file, this.state)
  }

  saveKeys() {
    if (!this.held) throw new Error('Key write requires writer lock')
    atomicJson(this.keysFile, this.keys)
  }

  release() {
    if (this.held) {
      fs.unlinkSync(this.lock)
      this.held = false
    }
  }
}
