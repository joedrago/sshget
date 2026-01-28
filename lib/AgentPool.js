import { spawn } from "child_process"
import { EventEmitter } from "events"

// Minimal binary protocol agent - only handles file reads
// Request: path_len(2) + path + offset(8) + length(8)
// Response: status(1) + data_len(8) + data (or error message if status=1)
const PYTHON_AGENT = `
import sys, struct

stdin, stdout = sys.stdin.buffer, sys.stdout.buffer

def read(n):
    d = b''
    while len(d) < n:
        c = stdin.read(n - len(d))
        if not c: sys.exit(0)
        d += c
    return d

while True:
    pl = struct.unpack('>H', read(2))[0]
    path = read(pl).decode()
    off, ln = struct.unpack('>QQ', read(16))
    try:
        with open(path, 'rb') as f:
            f.seek(off)
            data = f.read(ln)
        stdout.write(struct.pack('>BQ', 0, len(data)))
        stdout.write(data)
        stdout.flush()
    except Exception as e:
        err = str(e).encode()[:1000]
        stdout.write(struct.pack('>BQ', 1, len(err)))
        stdout.write(err)
        stdout.flush()
`.trim()

// Shell escape a string for use in remote commands
function shellEscape(str) {
    return `'${str.replace(/'/g, "'\\''")}'`
}

const SSH_OPTIONS = [
    "-o",
    "Ciphers=aes128-gcm@openssh.com,aes256-gcm@openssh.com,aes128-ctr,aes256-ctr",
    "-o",
    "IPQoS=throughput",
    "-o",
    "ServerAliveInterval=60",
    "-o",
    "StrictHostKeyChecking=accept-new"
]

export class AgentPool extends EventEmitter {
    constructor(options = {}) {
        super()
        this.user = options.user
        this.host = options.host
        this.tunnelCount = options.tunnels || 8
        this.compress = options.compress || false
        this.password = options.password || null
        this.privateKey = options.privateKey || null
        this.sshPort = options.sshPort || 22
        this.verbose = options.verbose || false

        this.agents = []
        this.connected = false
    }

    log(...args) {
        if (this.verbose) {
            console.error("[AgentPool]", ...args)
        }
    }

    buildSSHArgs() {
        const args = [
            "-T", // Disable PTY - required for binary protocol
            ...SSH_OPTIONS,
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
        args.push(`exec python3 -c ${shellEscape(PYTHON_AGENT)}`)

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

    // Execute a one-off remote command (for file listings, stat, glob, etc.)
    async execRemote(command) {
        return new Promise((resolve, reject) => {
            const sshArgs = ["-p", String(this.sshPort), ...SSH_OPTIONS]

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

        this.log(`Starting ${this.tunnelCount} agent connections...`)

        // Start agents in batches to avoid overwhelming the SSH server
        // Most servers have MaxStartups around 10, so batches of 8 should be safe
        const batchSize = 8
        for (let batchStart = 0; batchStart < this.tunnelCount; batchStart += batchSize) {
            const batchEnd = Math.min(batchStart + batchSize, this.tunnelCount)
            const batchPromises = []

            for (let i = batchStart; i < batchEnd; i++) {
                batchPromises.push(this.startAgent(i))
            }

            await Promise.all(batchPromises)

            // Small delay between batches if there are more to start
            if (batchEnd < this.tunnelCount) {
                await new Promise((resolve) => setTimeout(resolve, 200))
            }
        }

        this.connected = true
        this.emit("ready")
        this.log("All agents connected")
    }

    async startAgent(index) {
        return new Promise((resolve, reject) => {
            const sshArgs = this.buildSSHArgs()
            const { command, args } = this.wrapWithSSHPass("ssh", sshArgs)

            this.log(`Starting agent ${index}`)

            const proc = spawn(command, args, {
                stdio: ["pipe", "pipe", "pipe"]
            })

            const agent = {
                id: index,
                process: proc,
                ready: false,
                busy: false,
                jobInfo: null,
                readBuffer: Buffer.alloc(0),
                pendingRead: null
            }

            this.agents.push(agent)

            // Set up stdout data handler for binary protocol
            proc.stdout.on("data", (data) => {
                agent.readBuffer = Buffer.concat([agent.readBuffer, data])
                if (agent.pendingRead) {
                    agent.pendingRead.check()
                }
            })

            let stderrBuffer = ""
            const timeout = setTimeout(() => {
                reject(new Error(`Timeout waiting for agent ${index} to start`))
            }, 30000)

            proc.stderr.on("data", (data) => {
                stderrBuffer += data.toString()
                this.log(`Agent ${index} stderr:`, data.toString().trim())
            })

            proc.on("error", (err) => {
                clearTimeout(timeout)
                reject(err)
            })

            proc.on("close", (code) => {
                clearTimeout(timeout)
                if (!agent.ready) {
                    reject(new Error(`Agent ${index} exited with code ${code}: ${stderrBuffer}`))
                } else {
                    this.log(`Agent ${index} closed with code ${code}`)
                    agent.ready = false
                    this.emit("tunnel:status", this.getStates())
                }
            })

            // Agent starts immediately - mark ready after brief delay for SSH connection
            setTimeout(() => {
                if (!agent.ready) {
                    clearTimeout(timeout)
                    agent.ready = true
                    this.emit("tunnel:status", this.getStates())
                    resolve()
                }
            }, 500)
        })
    }

    // Read exactly n bytes from agent's buffer
    readExact(agent, n) {
        return new Promise((resolve) => {
            const check = () => {
                if (agent.readBuffer.length >= n) {
                    const data = agent.readBuffer.subarray(0, n)
                    agent.readBuffer = agent.readBuffer.subarray(n)
                    agent.pendingRead = null
                    resolve(data)
                }
            }

            agent.pendingRead = { check }
            check()
        })
    }

    // Read a byte range from a file, streaming chunks to callback
    async readRangeStreaming(agent, remotePath, offset, length, onData) {
        const startTime = Date.now()

        // Build and send request: path_len(2) + path + offset(8) + length(8)
        const pathBuf = Buffer.from(remotePath, "utf8")
        const request = Buffer.alloc(2 + pathBuf.length + 16)
        request.writeUInt16BE(pathBuf.length, 0)
        pathBuf.copy(request, 2)
        request.writeBigUInt64BE(BigInt(offset), 2 + pathBuf.length)
        request.writeBigUInt64BE(BigInt(length), 2 + pathBuf.length + 8)

        agent.process.stdin.write(request)

        // Read response header: status(1) + length(8)
        const respHeader = await this.readExact(agent, 9)
        const status = respHeader.readUInt8(0)
        const dataLen = Number(respHeader.readBigUInt64BE(1))

        this.log(`Agent ${agent.id}: got response header in ${Date.now() - startTime}ms, status=${status}, dataLen=${dataLen}`)

        if (status !== 0) {
            const errData = await this.readExact(agent, dataLen)
            throw new Error(errData.toString())
        }

        // Stream data in chunks as they arrive
        let remaining = dataLen
        let chunkCount = 0
        while (remaining > 0) {
            // Wait for any data to be available
            if (agent.readBuffer.length === 0) {
                await new Promise((resolve) => {
                    const check = () => {
                        if (agent.readBuffer.length > 0) {
                            agent.pendingRead = null
                            resolve()
                        }
                    }
                    agent.pendingRead = { check }
                    // Check immediately in case data arrived between the if and setting pendingRead
                    check()
                })
            }

            const chunkSize = Math.min(remaining, agent.readBuffer.length)
            const chunk = agent.readBuffer.subarray(0, chunkSize)
            agent.readBuffer = agent.readBuffer.subarray(chunkSize)
            remaining -= chunkSize
            chunkCount++

            onData(chunk)
        }

        this.log(`Agent ${agent.id}: transferred ${dataLen} bytes in ${chunkCount} chunks, took ${Date.now() - startTime}ms`)
    }

    // List remote files (using execRemote, same as before)
    async listRemoteFiles(path) {
        const isDir = await this.execRemote(`test -d ${JSON.stringify(path)} && echo "dir" || echo "file"`)

        // Detect which stat syntax to use (GNU vs BSD)
        const statCheck = await this.execRemote('stat -c "%s" /dev/null >/dev/null 2>&1 && echo "gnu" || echo "bsd"')
        const isGnu = statCheck.trim() === "gnu"

        if (isDir.trim() === "file") {
            const statCmd = isGnu ? `stat -c"%s %a %Y" ${JSON.stringify(path)}` : `stat -f"%z %Lp %m" ${JSON.stringify(path)}`
            const statOutput = await this.execRemote(statCmd)
            const [size, mode, mtime] = statOutput.trim().split(" ")
            const name = path.split("/").pop()
            return [
                {
                    path: name,
                    fullPath: path,
                    size: parseInt(size, 10),
                    mode: parseInt(mode, 8),
                    mtime: parseInt(mtime, 10)
                }
            ]
        }

        const statFormat = isGnu ? 'stat -c"%s %a %Y %n"' : 'stat -f"%z %Lp %m %N"'
        // Use + instead of \; to batch files into fewer stat calls (much faster for many files)
        const output = await this.execRemote(`find -P ${JSON.stringify(path)} -type f -exec ${statFormat} {} +`)

        if (!output.trim()) {
            return []
        }

        const files = []
        const lines = output.trim().split("\n")

        for (const line of lines) {
            const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
            if (match) {
                const size = parseInt(match[1], 10)
                const mode = parseInt(match[2], 8)
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

    // Acquire an available agent for file transfer
    acquire() {
        const available = this.agents.find((a) => a.ready && !a.busy)
        if (!available) {
            return null
        }
        available.busy = true
        this.emit("tunnel:status", this.getStates())
        return available
    }

    release(id) {
        const agent = this.agents.find((a) => a.id === id)
        if (agent) {
            agent.busy = false
            agent.jobInfo = null
            this.emit("tunnel:status", this.getStates())
        }
    }

    setJobInfo(id, info) {
        const agent = this.agents.find((a) => a.id === id)
        if (agent) {
            agent.jobInfo = info
            this.emit("tunnel:status", this.getStates())
        }
    }

    getStates() {
        return this.agents.map((a) => ({
            id: a.id,
            ready: a.ready,
            busy: a.busy,
            jobInfo: a.jobInfo
        }))
    }

    async close() {
        this.connected = false

        for (const agent of this.agents) {
            if (agent.process && !agent.process.killed) {
                agent.process.stdin.end()
                agent.process.kill("SIGTERM")
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 500))

        for (const agent of this.agents) {
            if (agent.process && !agent.process.killed) {
                agent.process.kill("SIGKILL")
            }
        }

        this.agents = []
        this.emit("closed")
    }
}
