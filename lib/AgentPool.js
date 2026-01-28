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
        const batchSize = 6
        for (let batchStart = 0; batchStart < this.tunnelCount; batchStart += batchSize) {
            const batchEnd = Math.min(batchStart + batchSize, this.tunnelCount)
            const batchPromises = []

            for (let i = batchStart; i < batchEnd; i++) {
                batchPromises.push(this.startAgentWithRetry(i))
            }

            await Promise.all(batchPromises)

            // Small delay between batches if there are more to start
            if (batchEnd < this.tunnelCount) {
                await new Promise((resolve) => setTimeout(resolve, 300))
            }
        }

        this.connected = true
        this.emit("ready")
        this.log("All agents connected")
    }

    async startAgentWithRetry(index, maxRetries = 3) {
        let lastError
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await this.startAgent(index)
            } catch (err) {
                lastError = err
                // Check if it's a connection rejected error (worth retrying)
                if (err.message.includes("Connection reset") || err.message.includes("kex_exchange")) {
                    const delay = 500 * (attempt + 1) // 500ms, 1000ms, 1500ms
                    this.log(`Agent ${index} connection failed, retrying in ${delay}ms... (${err.message})`)
                    await new Promise((resolve) => setTimeout(resolve, delay))
                } else {
                    // Non-retryable error
                    throw err
                }
            }
        }
        throw lastError
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

            // Remove any existing agent with this index (from failed retry)
            this.agents = this.agents.filter((a) => a.id !== index)
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
                    // Reject any pending read with an error so it doesn't wait forever
                    if (agent.pendingRead && agent.pendingRead.reject) {
                        agent.pendingRead.reject(new Error(`Agent ${index} connection closed unexpectedly`))
                    }
                    this.emit("tunnel:status", this.getStates())
                }
            })

            // Verify agent is responsive after brief delay for SSH connection setup
            setTimeout(async () => {
                if (agent.ready) return // Already resolved/rejected

                try {
                    clearTimeout(timeout)
                    await this.pingAgent(agent, 10000) // 10s timeout for initial ping
                    agent.ready = true
                    this.emit("tunnel:status", this.getStates())
                    this.log(`Agent ${index} ready (verified via ping)`)
                    resolve()
                } catch (err) {
                    reject(new Error(`Agent ${index} failed health check: ${err.message}`))
                }
            }, 300)
        })
    }

    // Read exactly n bytes from agent's buffer (with stall timeout)
    // Timeout resets whenever we receive data - only triggers if no data flows for stallTimeoutMs
    readExact(agent, n, stallTimeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            let timer = null
            let resolved = false
            let lastBufferLen = agent.readBuffer.length

            const cleanup = () => {
                if (timer) {
                    clearTimeout(timer)
                    timer = null
                }
                agent.pendingRead = null
            }

            const doReject = (err) => {
                if (!resolved) {
                    resolved = true
                    cleanup()
                    reject(err)
                }
            }

            const resetTimer = () => {
                if (timer) {
                    clearTimeout(timer)
                }
                timer = setTimeout(() => {
                    doReject(
                        new Error(
                            `Agent ${agent.id} read stalled: no data for ${stallTimeoutMs}ms, ` +
                                `need ${n} bytes, have ${agent.readBuffer.length}`
                        )
                    )
                }, stallTimeoutMs)
            }

            const check = () => {
                if (resolved) return
                // If buffer grew since last check, reset the stall timer
                if (agent.readBuffer.length > lastBufferLen) {
                    lastBufferLen = agent.readBuffer.length
                    resetTimer()
                }
                if (agent.readBuffer.length >= n) {
                    resolved = true
                    cleanup()
                    const data = agent.readBuffer.subarray(0, n)
                    agent.readBuffer = agent.readBuffer.subarray(n)
                    resolve(data)
                }
            }

            resetTimer()
            agent.pendingRead = { check, reject: doReject }
            check()
        })
    }

    // Read a byte range from a file, streaming chunks to callback
    // stallTimeoutMs: how long to wait with no data before considering it stalled
    async readRangeStreaming(agent, remotePath, offset, length, onData, stallTimeoutMs = 30000) {
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
        const respHeader = await this.readExact(agent, 9, stallTimeoutMs)
        const status = respHeader.readUInt8(0)
        const dataLen = Number(respHeader.readBigUInt64BE(1))

        this.log(`Agent ${agent.id}: got response header in ${Date.now() - startTime}ms, status=${status}, dataLen=${dataLen}`)

        if (status !== 0) {
            const errData = await this.readExact(agent, dataLen, stallTimeoutMs)
            throw new Error(errData.toString())
        }

        // Stream data in chunks as they arrive (with stall detection)
        let remaining = dataLen
        let chunkCount = 0
        let lastProgressTime = Date.now()

        while (remaining > 0) {
            // Wait for any data to be available (with timeout)
            if (agent.readBuffer.length === 0) {
                await new Promise((resolve, reject) => {
                    let timer = null
                    let resolved = false

                    const cleanup = () => {
                        if (timer) {
                            clearTimeout(timer)
                            timer = null
                        }
                        agent.pendingRead = null
                    }

                    const doReject = (err) => {
                        if (!resolved) {
                            resolved = true
                            cleanup()
                            reject(err)
                        }
                    }

                    const check = () => {
                        if (resolved) return
                        if (agent.readBuffer.length > 0) {
                            resolved = true
                            cleanup()
                            resolve()
                        }
                    }

                    timer = setTimeout(() => {
                        const elapsed = Date.now() - lastProgressTime
                        doReject(
                            new Error(
                                `Agent ${agent.id} stalled: no data for ${elapsed}ms, ` +
                                    `${remaining}/${dataLen} bytes remaining, file: ${remotePath}`
                            )
                        )
                    }, stallTimeoutMs)

                    agent.pendingRead = { check, reject: doReject }
                    check()
                })
            }

            const chunkSize = Math.min(remaining, agent.readBuffer.length)
            const chunk = agent.readBuffer.subarray(0, chunkSize)
            agent.readBuffer = agent.readBuffer.subarray(chunkSize)
            remaining -= chunkSize
            chunkCount++
            lastProgressTime = Date.now()

            onData(chunk)
        }

        const elapsed = Date.now() - startTime
        const speedMBs = (dataLen / (1024 * 1024) / (elapsed / 1000)).toFixed(2)
        this.log(`Agent ${agent.id}: transferred ${dataLen} bytes in ${chunkCount} chunks, ${elapsed}ms (${speedMBs} MB/s)`)
    }

    // Health check: verify agent responds to a minimal request
    // Reads 0 bytes from /dev/null which should return immediately
    async pingAgent(agent, timeoutMs = 5000) {
        const pathBuf = Buffer.from("/dev/null", "utf8")
        const request = Buffer.alloc(2 + pathBuf.length + 16)
        request.writeUInt16BE(pathBuf.length, 0)
        pathBuf.copy(request, 2)
        request.writeBigUInt64BE(0n, 2 + pathBuf.length) // offset 0
        request.writeBigUInt64BE(0n, 2 + pathBuf.length + 8) // length 0

        agent.process.stdin.write(request)

        // Read response header: status(1) + length(8)
        const respHeader = await this.readExact(agent, 9, timeoutMs)
        const status = respHeader.readUInt8(0)
        const dataLen = Number(respHeader.readBigUInt64BE(1))

        if (status !== 0) {
            const errData = await this.readExact(agent, dataLen, timeoutMs)
            throw new Error(`Agent ping failed: ${errData.toString()}`)
        }

        // Should be 0 bytes of data (we asked for 0)
        if (dataLen !== 0) {
            // Drain any unexpected data
            await this.readExact(agent, dataLen, timeoutMs)
        }

        return true
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

    // Acquire an available healthy agent for file transfer
    acquire() {
        const available = this.agents.find((a) => a.ready && !a.busy && !a.unhealthy)
        if (!available) {
            return null
        }
        available.busy = true
        this.emit("tunnel:status", this.getStates())
        return available
    }

    // Mark an agent as unhealthy (stalled, errored, etc.)
    markUnhealthy(id, reason) {
        const agent = this.agents.find((a) => a.id === id)
        if (agent) {
            agent.unhealthy = true
            agent.unhealthyReason = reason
            this.log(`Agent ${id} marked unhealthy: ${reason}`)
            this.emit("tunnel:status", this.getStates())

            // Count healthy agents
            const healthyCount = this.agents.filter((a) => a.ready && !a.unhealthy).length
            this.log(`${healthyCount}/${this.agents.length} agents still healthy`)
        }
    }

    // Get count of healthy agents
    getHealthyCount() {
        return this.agents.filter((a) => a.ready && !a.unhealthy).length
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
            unhealthy: a.unhealthy || false,
            unhealthyReason: a.unhealthyReason || null,
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
