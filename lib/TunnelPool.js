import { spawn } from "child_process"
import { EventEmitter } from "events"
import { createServer } from "net"

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
server = http.server.ThreadingHTTPServer(('127.0.0.1', port), RangeHandler)
print(f"Serving HTTP on 127.0.0.1 port {port}", file=sys.stderr, flush=True)
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

export class TunnelPool extends EventEmitter {
    constructor(options = {}) {
        super()
        this.user = options.user
        this.host = options.host
        this.remotePath = options.remotePath || "/"
        this.tunnelCount = options.tunnels || 8
        this.basePort = options.basePort ?? "auto"
        this.compress = options.compress || false
        this.password = options.password || null
        this.privateKey = options.privateKey || null
        this.sshPort = options.sshPort || 22
        this.verbose = options.verbose || false

        this.tunnels = []
        this.primaryProcess = null
        this.secondaryProcesses = []
        this.connected = false
        this.remotePort = null // Will be set during connect if auto
        this.localPorts = [] // Will hold actual local ports used
    }

    log(...args) {
        if (this.verbose) {
            console.error("[TunnelPool]", ...args)
        }
    }

    // Find an available local port by binding to port 0
    async findLocalPort() {
        return new Promise((resolve, reject) => {
            const server = createServer()
            server.listen(0, "127.0.0.1", () => {
                const port = server.address().port
                server.close(() => resolve(port))
            })
            server.on("error", reject)
        })
    }

    // Find multiple available local ports
    async findLocalPorts(count) {
        const ports = []
        for (let i = 0; i < count; i++) {
            ports.push(await this.findLocalPort())
        }
        return ports
    }

    // Find an available remote port
    async findRemotePort() {
        // Use semicolons to keep it on one line - simpler escaping
        const pythonCode =
            "import socket; s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1]); s.close()"
        const result = await this.execRemote(`python3 -c "${pythonCode}"`)
        return parseInt(result.trim(), 10)
    }

    buildPrimarySSHArgs(localPort, remotePort) {
        const args = [
            "-tt", // Force PTY allocation - ensures remote process dies when SSH drops
            "-L",
            `${localPort}:127.0.0.1:${remotePort}`,
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ServerAliveInterval=60",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "IPQoS=throughput",
            "-o",
            "Ciphers=aes128-gcm@openssh.com,aes256-gcm@openssh.com,aes128-ctr,aes256-ctr",
            "-p",
            String(this.sshPort)
        ]

        if (this.compress) {
            args.push("-C")
        }

        if (this.privateKey) {
            args.push("-i", this.privateKey)
        }

        args.push(`${this.user}@${this.host}`)

        // Remote command: cd to remotePath and start Python HTTP server
        // Using -tt ensures the Python server gets SIGHUP when SSH disconnects
        const remoteCmd = `cd ${shellEscape(this.remotePath)} && exec python3 -c ${shellEscape(PYTHON_HTTP_SERVER)} ${remotePort}`
        args.push(remoteCmd)

        return args
    }

    buildSecondarySSHArgs(localPort, remotePort) {
        const args = [
            "-N",
            "-L",
            `${localPort}:127.0.0.1:${remotePort}`,
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ServerAliveInterval=60",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "IPQoS=throughput",
            "-o",
            "Ciphers=aes128-gcm@openssh.com,aes256-gcm@openssh.com,aes128-ctr,aes256-ctr",
            "-p",
            String(this.sshPort)
        ]

        if (this.compress) {
            args.push("-C")
        }

        if (this.privateKey) {
            args.push("-i", this.privateKey)
        }

        args.push(`${this.user}@${this.host}`)

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

    async checkPythonVersion() {
        this.log("Checking remote Python version...")
        try {
            const output = await this.execRemote('python3 -c "import sys; print(sys.version_info[0], sys.version_info[1])"')
            const parts = output.trim().split(/\s+/)
            const major = parseInt(parts[0], 10)
            const minor = parseInt(parts[1], 10)
            this.log(`Remote Python version: ${major}.${minor}`)
            if (major < 3 || (major === 3 && minor < 7)) {
                throw new Error(`Python 3.7+ is required on the remote server, but found Python ${major}.${minor}`)
            }
        } catch (err) {
            if (err.message.includes("Python 3.7+")) {
                throw err
            }
            throw new Error("python3 is not available on the remote server. Python 3.7+ is required.")
        }
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

        // Check Python version on remote server
        await this.checkPythonVersion()

        // Handle auto port detection
        if (this.basePort === "auto") {
            this.log("Auto-detecting available ports...")

            // Find available remote port for the HTTP server
            this.remotePort = await this.findRemotePort()
            this.log("Found available remote port:", this.remotePort)

            // Find available local ports for all tunnels
            this.localPorts = await this.findLocalPorts(this.tunnelCount)
            this.log("Found available local ports:", this.localPorts)
        } else {
            // Use fixed port allocation
            this.remotePort = this.basePort
            this.localPorts = Array.from({ length: this.tunnelCount }, (_, i) => this.basePort + i)
        }

        // Start primary tunnel (runs the HTTP server)
        await this.startPrimaryTunnel()

        // Start secondary tunnels sequentially with small delays (like whatsync)
        for (let i = 1; i < this.tunnelCount; i++) {
            await this.startSecondaryTunnel(i)
            // Small delay between starting tunnels
            await new Promise((resolve) => setTimeout(resolve, 100))
        }

        this.connected = true
        this.emit("ready")
    }

    async startPrimaryTunnel() {
        return new Promise((resolve, reject) => {
            const localPort = this.localPorts[0]
            const sshArgs = this.buildPrimarySSHArgs(localPort, this.remotePort)
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

            let outputBuffer = ""
            const timeout = setTimeout(() => {
                reject(new Error("Timeout waiting for SSH server to start"))
            }, 30000)

            const checkReady = () => {
                // Match whatsync: look for "Serving HTTP on" from Python server
                if (outputBuffer.includes("Serving HTTP on")) {
                    clearTimeout(timeout)
                    tunnel.ready = true
                    this.emit("tunnel:status", this.getStates())
                    resolve()
                }
            }

            proc.stdout.on("data", (data) => {
                const str = data.toString()
                outputBuffer += str
                this.log("Primary stdout:", str)
                checkReady()
            })

            proc.stderr.on("data", (data) => {
                const str = data.toString()
                outputBuffer += str
                this.log("Primary stderr:", str)
                checkReady()
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
        const localPort = this.localPorts[index]
        const remotePort = this.remotePort // Connect to same remote port as primary
        const sshArgs = this.buildSecondarySSHArgs(localPort, remotePort)
        const { command, args } = this.wrapWithSSHPass("ssh", sshArgs)

        this.log(`Starting secondary tunnel ${index}:`, command, args.join(" "))

        const proc = spawn(command, args, {
            stdio: ["pipe", "pipe", "pipe"]
        })

        this.secondaryProcesses.push(proc)

        const tunnel = {
            id: index,
            localPort,
            process: proc,
            ready: true, // Mark ready immediately (like whatsync)
            busy: false,
            jobInfo: null
        }

        this.tunnels.push(tunnel)

        proc.stderr.on("data", (data) => {
            this.log(`Secondary ${index} stderr:`, data.toString())
        })

        proc.on("error", (err) => {
            this.log(`Secondary ${index} error:`, err.message)
        })

        proc.on("close", (code) => {
            if (code !== 0) {
                this.log(`Secondary tunnel ${index} exited with code ${code}`)
            }
        })

        this.emit("tunnel:status", this.getStates())
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
            // Get size, mode (octal permissions), and mtime (epoch seconds)
            const statCmd = isGnu ? `stat -c"%s %a %Y" ${JSON.stringify(path)}` : `stat -f"%z %Lp %m" ${JSON.stringify(path)}`
            const statOutput = await this.execRemote(statCmd)
            const [size, mode, mtime] = statOutput.trim().split(" ")
            const name = path.split("/").pop()
            return [
                {
                    path: name,
                    fullPath: path,
                    size: parseInt(size, 10),
                    mode: parseInt(mode, 8), // Parse octal string to number
                    mtime: parseInt(mtime, 10)
                }
            ]
        }

        // Format: size mode mtime path (space-separated, path may contain spaces so it's last)
        const statFormat = isGnu ? 'stat -c"%s %a %Y %n"' : 'stat -f"%z %Lp %m %N"'
        // -P prevents following symlinks
        const output = await this.execRemote(`find -P ${JSON.stringify(path)} -type f -exec ${statFormat} {} \\;`)

        if (!output.trim()) {
            return []
        }

        const files = []
        const lines = output.trim().split("\n")

        for (const line of lines) {
            // Match: size mode mtime path (path can contain spaces)
            const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
            if (match) {
                const size = parseInt(match[1], 10)
                const mode = parseInt(match[2], 8) // Parse octal string to number
                const mtime = parseInt(match[3], 10)
                const fullPath = match[4]
                const relativePath = fullPath.startsWith(path) ? fullPath.slice(path.length).replace(/^\//, "") : fullPath
                files.push({
                    path: relativePath,
                    fullPath,
                    size,
                    mode,
                    mtime
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

    async expandWildcard(pattern) {
        // Use shell globbing to expand the pattern
        // We need to handle the case where pattern might contain special characters
        // Using printf to output each match on its own line
        const cmd = `for f in ${pattern}; do [ -e "$f" ] && printf '%s\\n' "$f"; done`
        try {
            const output = await this.execRemote(cmd)
            if (!output.trim()) {
                return []
            }
            return output.trim().split("\n").filter(Boolean)
        } catch {
            return []
        }
    }

    async close() {
        this.connected = false

        // Close secondary tunnels first
        for (const proc of this.secondaryProcesses) {
            if (proc && !proc.killed) {
                proc.kill("SIGTERM")
            }
        }

        // Give them a moment to exit
        await new Promise((resolve) => setTimeout(resolve, 500))

        // Force kill any still alive
        for (const proc of this.secondaryProcesses) {
            if (proc && !proc.killed) {
                proc.kill("SIGKILL")
            }
        }

        // Close primary tunnel
        if (this.primaryProcess && !this.primaryProcess.killed) {
            this.primaryProcess.kill("SIGTERM")

            // Wait for process to exit
            await new Promise((resolve) => {
                const timer = setTimeout(() => resolve(), 2000)
                this.primaryProcess.on("exit", () => {
                    clearTimeout(timer)
                    resolve()
                })
            })

            // Force kill if still alive
            if (!this.primaryProcess.killed) {
                this.primaryProcess.kill("SIGKILL")
            }
        }

        this.tunnels = []
        this.secondaryProcesses = []
        this.emit("closed")
    }
}
