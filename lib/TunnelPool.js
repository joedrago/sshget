import { spawn } from "child_process"
import { EventEmitter } from "events"

// Minimal Python HTTP server with Range request support (from whatsync)
const PYTHON_HTTP_SERVER = `
import http.server, os, sys

class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            f = open(path, 'rb')
        except OSError:
            self.send_error(404, "File not found")
            return None
        size = os.fstat(f.fileno()).st_size
        start, end = 0, size - 1
        range_header = self.headers.get('Range')
        if range_header and range_header.startswith('bytes='):
            parts = range_header[6:].split('-')
            start = int(parts[0]) if parts[0] else 0
            end = int(parts[1]) if parts[1] else size - 1
            if start >= size:
                self.send_error(416, "Range not satisfiable")
                f.close()
                return None
            end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        length = end - start + 1
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        f.seek(start)
        return _LimitedFile(f, length)

class _LimitedFile:
    def __init__(self, f, limit):
        self.f, self.left = f, limit
    def read(self, n=-1):
        if self.left <= 0: return b''
        n = self.left if n < 0 else min(n, self.left)
        data = self.f.read(n)
        self.left -= len(data)
        return data
    def close(self):
        self.f.close()

port = int(sys.argv[1])
print(f"SSHGET_SERVER_READY:{port}", flush=True)
server = http.server.ThreadingHTTPServer(('127.0.0.1', port), RangeHandler)
server.serve_forever()
`.trim()

// Shell escape a string for use in remote commands
function shellEscape(str) {
    return `'${str.replace(/'/g, "'\\''")}'`
}

const SSH_OPTIONS_BASE = [
    "-o",
    "Ciphers=aes128-gcm@openssh.com,aes256-gcm@openssh.com,aes128-ctr,aes256-ctr",
    "-o",
    "IPQoS=throughput",
    "-o",
    "ServerAliveInterval=60",
    "-o",
    "StrictHostKeyChecking=accept-new"
]

const SSH_OPTIONS_TUNNEL = [...SSH_OPTIONS_BASE, "-o", "ExitOnForwardFailure=yes"]

export class TunnelPool extends EventEmitter {
    constructor(options = {}) {
        super()
        this.user = options.user
        this.host = options.host
        this.remotePath = options.remotePath || "/"
        this.tunnelCount = options.tunnels || 8
        this.basePort = options.basePort || 12346
        this.compress = options.compress || false
        this.password = options.password || null
        this.privateKey = options.privateKey || null
        this.sshPort = options.sshPort || 22
        this.verbose = options.verbose || false

        this.tunnels = []
        this.remotePort = null
        this.primaryProcess = null
        this.connected = false
    }

    log(...args) {
        if (this.verbose) {
            console.error("[TunnelPool]", ...args)
        }
    }

    buildSSHArgs(localPort, isPrimary = false) {
        const args = []

        if (this.compress) {
            args.push("-C")
        }

        if (this.privateKey) {
            args.push("-i", this.privateKey)
        }

        args.push("-p", String(this.sshPort))
        args.push(...SSH_OPTIONS_TUNNEL)

        if (isPrimary) {
            args.push("-tt")
        } else {
            args.push("-N")
        }

        args.push("-L", `${localPort}:127.0.0.1:${this.remotePort || this.basePort}`)

        args.push(`${this.user}@${this.host}`)

        if (isPrimary) {
            // Remote command: cd to remotePath and start Python HTTP server with Range support
            const remoteCmd = `cd ${shellEscape(this.remotePath)} && python3 -c ${shellEscape(PYTHON_HTTP_SERVER)} ${this.remotePort || this.basePort}`
            args.push(remoteCmd)
        }

        return args
    }

    wrapWithSSHPass(command, args) {
        if (!this.password) {
            return { command, args }
        }
        return {
            command: "sshpass",
            args: ["-p", this.password, command, ...args]
        }
    }

    async checkSSHPass() {
        if (!this.password) return true

        return new Promise((resolve) => {
            const proc = spawn("which", ["sshpass"])
            proc.on("close", (code) => {
                resolve(code === 0)
            })
        })
    }

    async connect() {
        if (this.password) {
            const hasSshpass = await this.checkSSHPass()
            if (!hasSshpass) {
                throw new Error(
                    "sshpass is required for password authentication but not found. Install it with: brew install hudochenkov/sshpass/sshpass"
                )
            }
        }

        this.remotePort = this.basePort + this.tunnelCount

        await this.startPrimaryTunnel()

        const secondaryPromises = []
        for (let i = 1; i < this.tunnelCount; i++) {
            secondaryPromises.push(this.startSecondaryTunnel(i))
        }
        await Promise.all(secondaryPromises)

        this.connected = true
        this.emit("ready")
    }

    async startPrimaryTunnel() {
        return new Promise((resolve, reject) => {
            const localPort = this.basePort
            const sshArgs = this.buildSSHArgs(localPort, true)
            const { command, args } = this.wrapWithSSHPass("ssh", sshArgs)

            this.log("Starting primary tunnel:", command, args.join(" "))

            const proc = spawn(command, args, {
                stdio: ["pipe", "pipe", "pipe"]
            })

            this.primaryProcess = proc

            const tunnel = {
                id: 0,
                localPort,
                process: proc,
                ready: false,
                busy: false,
                jobInfo: null
            }

            this.tunnels.push(tunnel)

            let output = ""
            const timeout = setTimeout(() => {
                reject(new Error("Timeout waiting for SSH server to start"))
            }, 30000)

            proc.stdout.on("data", (data) => {
                output += data.toString()
                this.log("Primary stdout:", data.toString())
                if (output.includes("SSHGET_SERVER_READY:")) {
                    clearTimeout(timeout)
                    tunnel.ready = true
                    this.emit("tunnel:status", this.getStates())
                    resolve()
                }
            })

            proc.stderr.on("data", (data) => {
                this.log("Primary stderr:", data.toString())
            })

            proc.on("error", (err) => {
                clearTimeout(timeout)
                reject(err)
            })

            proc.on("close", (code) => {
                clearTimeout(timeout)
                if (!tunnel.ready) {
                    reject(new Error(`SSH connection failed with code ${code}`))
                }
            })
        })
    }

    async startSecondaryTunnel(index) {
        return new Promise((resolve, reject) => {
            const localPort = this.basePort + index
            const sshArgs = this.buildSSHArgs(localPort, false)
            const { command, args } = this.wrapWithSSHPass("ssh", sshArgs)

            this.log(`Starting secondary tunnel ${index}:`, command, args.join(" "))

            const proc = spawn(command, args, {
                stdio: ["pipe", "pipe", "pipe"]
            })

            const tunnel = {
                id: index,
                localPort,
                process: proc,
                ready: false,
                busy: false,
                jobInfo: null
            }

            this.tunnels.push(tunnel)

            const timeout = setTimeout(() => {
                tunnel.ready = true
                this.emit("tunnel:status", this.getStates())
                resolve()
            }, 2000)

            proc.stderr.on("data", (data) => {
                this.log(`Secondary ${index} stderr:`, data.toString())
            })

            proc.on("error", (err) => {
                clearTimeout(timeout)
                reject(err)
            })

            proc.on("close", (code) => {
                clearTimeout(timeout)
                if (!tunnel.ready && code !== 0) {
                    reject(new Error(`Secondary tunnel ${index} failed with code ${code}`))
                }
            })

            setTimeout(() => {
                tunnel.ready = true
                this.emit("tunnel:status", this.getStates())
                resolve()
            }, 1000)
        })
    }

    acquire() {
        const available = this.tunnels.find((t) => t.ready && !t.busy)
        if (!available) {
            return null
        }
        available.busy = true
        this.emit("tunnel:status", this.getStates())
        return {
            id: available.id,
            url: `http://127.0.0.1:${available.localPort}`
        }
    }

    release(id) {
        const tunnel = this.tunnels.find((t) => t.id === id)
        if (tunnel) {
            tunnel.busy = false
            tunnel.jobInfo = null
            this.emit("tunnel:status", this.getStates())
        }
    }

    setJobInfo(id, info) {
        const tunnel = this.tunnels.find((t) => t.id === id)
        if (tunnel) {
            tunnel.jobInfo = info
            this.emit("tunnel:status", this.getStates())
        }
    }

    getStates() {
        return this.tunnels.map((t) => ({
            id: t.id,
            port: t.localPort,
            ready: t.ready,
            busy: t.busy,
            jobInfo: t.jobInfo
        }))
    }

    async execRemote(command) {
        return new Promise((resolve, reject) => {
            const sshArgs = ["-p", String(this.sshPort), ...SSH_OPTIONS_BASE]

            if (this.compress) {
                sshArgs.push("-C")
            }

            if (this.privateKey) {
                sshArgs.push("-i", this.privateKey)
            }

            sshArgs.push(`${this.user}@${this.host}`, command)

            const { command: cmd, args } = this.wrapWithSSHPass("ssh", sshArgs)

            this.log("Executing remote command:", cmd, args.join(" "))

            const proc = spawn(cmd, args, {
                stdio: ["pipe", "pipe", "pipe"]
            })

            let stdout = ""
            let stderr = ""

            proc.stdout.on("data", (data) => {
                stdout += data.toString()
            })

            proc.stderr.on("data", (data) => {
                stderr += data.toString()
            })

            proc.on("close", (code) => {
                if (code === 0) {
                    resolve(stdout.trim())
                } else {
                    reject(new Error(`Remote command failed: ${stderr || stdout}`))
                }
            })

            proc.on("error", reject)
        })
    }

    async listRemoteFiles(path) {
        const isDir = await this.execRemote(`test -d ${JSON.stringify(path)} && echo "dir" || echo "file"`)

        // Detect which stat syntax to use (GNU vs BSD)
        const statCheck = await this.execRemote('stat -c "%s" /dev/null >/dev/null 2>&1 && echo "gnu" || echo "bsd"')
        const isGnu = statCheck.trim() === "gnu"

        if (isDir.trim() === "file") {
            const statCmd = isGnu ? `stat -c%s ${JSON.stringify(path)}` : `stat -f%z ${JSON.stringify(path)}`
            const size = await this.execRemote(statCmd)
            const name = path.split("/").pop()
            return [
                {
                    path: name,
                    fullPath: path,
                    size: parseInt(size.trim(), 10)
                }
            ]
        }

        const statFormat = isGnu ? 'stat -c"%s %n"' : 'stat -f"%z %N"'
        // -P prevents following symlinks
        const output = await this.execRemote(`find -P ${JSON.stringify(path)} -type f -exec ${statFormat} {} \\;`)

        if (!output.trim()) {
            return []
        }

        const files = []
        const lines = output.trim().split("\n")

        for (const line of lines) {
            const match = line.match(/^(\d+)\s+(.+)$/)
            if (match) {
                const size = parseInt(match[1], 10)
                const fullPath = match[2]
                const relativePath = fullPath.startsWith(path) ? fullPath.slice(path.length).replace(/^\//, "") : fullPath
                files.push({
                    path: relativePath,
                    fullPath,
                    size
                })
            }
        }

        return files
    }

    async getRemotePathInfo(path) {
        try {
            const isDir = await this.execRemote(`test -d ${JSON.stringify(path)} && echo "dir" || echo "file"`)
            return {
                exists: true,
                isDirectory: isDir.trim() === "dir"
            }
        } catch {
            return { exists: false, isDirectory: false }
        }
    }

    async close() {
        this.connected = false

        for (const tunnel of this.tunnels) {
            if (tunnel.process) {
                tunnel.process.kill("SIGTERM")
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 500))

        for (const tunnel of this.tunnels) {
            if (tunnel.process && !tunnel.process.killed) {
                tunnel.process.kill("SIGKILL")
            }
        }

        this.tunnels = []
        this.emit("closed")
    }
}
