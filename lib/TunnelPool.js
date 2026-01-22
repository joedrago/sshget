import { spawn } from "child_process"
import { EventEmitter } from "events"

const PYTHON_HTTP_SERVER = `
import http.server
import socketserver
import os
import sys
import re

class RangeRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        self.serve_directory = directory or os.getcwd()
        super().__init__(*args, directory=self.serve_directory, **kwargs)

    def log_message(self, format, *args):
        pass  # Suppress logging

    def do_GET(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().do_GET()

        try:
            file_size = os.path.getsize(path)
        except OSError:
            self.send_error(404, "File not found")
            return

        range_header = self.headers.get('Range')
        if range_header:
            match = re.match(r'bytes=(\\d+)-(\\d*)', range_header)
            if match:
                start = int(match.group(1))
                end = int(match.group(2)) if match.group(2) else file_size - 1
                if start >= file_size:
                    self.send_error(416, "Requested range not satisfiable")
                    return
                end = min(end, file_size - 1)
                length = end - start + 1

                self.send_response(206)
                self.send_header("Content-Type", self.guess_type(path))
                self.send_header("Content-Length", str(length))
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()

                with open(path, 'rb') as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                return

        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Length", str(file_size))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

        with open(path, 'rb') as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

port = int(sys.argv[1])
directory = sys.argv[2] if len(sys.argv) > 2 else '/'
os.chdir(directory)
handler = lambda *args, **kwargs: RangeRequestHandler(*args, directory=directory, **kwargs)
server = ThreadedHTTPServer(('127.0.0.1', port), handler)
print(f"SSHGET_SERVER_READY:{port}", flush=True)
server.serve_forever()
`.trim()

const SSH_OPTIONS = [
    "-o",
    "Ciphers=aes128-gcm@openssh.com,aes256-gcm@openssh.com,aes128-ctr,aes256-ctr",
    "-o",
    "IPQoS=throughput",
    "-o",
    "ServerAliveInterval=60",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StrictHostKeyChecking=accept-new"
]

export class TunnelPool extends EventEmitter {
    constructor(options = {}) {
        super()
        this.user = options.user
        this.host = options.host
        this.remotePath = options.remotePath || "/"
        this.tunnelCount = options.tunnels || 4
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
        args.push(...SSH_OPTIONS)

        if (isPrimary) {
            args.push("-tt")
        } else {
            args.push("-N")
        }

        args.push("-L", `${localPort}:127.0.0.1:${this.remotePort || this.basePort}`)

        args.push(`${this.user}@${this.host}`)

        if (isPrimary) {
            const pythonCmd = `python3 -c ${JSON.stringify(PYTHON_HTTP_SERVER)} ${this.remotePort || this.basePort} ${JSON.stringify(this.remotePath)}`
            args.push(pythonCmd)
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
            const sshArgs = ["-p", String(this.sshPort), ...SSH_OPTIONS.filter((o) => !o.includes("ExitOnForwardFailure"))]

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

        if (isDir.trim() === "file") {
            const size = await this.execRemote(
                `stat -f%z ${JSON.stringify(path)} 2>/dev/null || stat -c%s ${JSON.stringify(path)}`
            )
            const name = path.split("/").pop()
            return [
                {
                    path: name,
                    fullPath: path,
                    size: parseInt(size.trim(), 10)
                }
            ]
        }

        const output = await this.execRemote(
            `find ${JSON.stringify(path)} -type f -exec stat -f"%z %N" {} \\; 2>/dev/null || find ${JSON.stringify(path)} -type f -exec stat -c"%s %n" {} \\;`
        )

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
