import { spawn } from "child_process"
import { EventEmitter } from "events"
import { log as fileLog } from "./Logger.js"

// Minimal binary protocol agent - only handles file reads
// Request: path_len(2) + path + offset(8) + length(8)
// Response: status(1) + data_len(8) + data (or error message if status=1)
// Streams data in 256KB chunks to avoid memory issues with large files
const PYTHON_AGENT = `
import sys, struct, os

stdin, stdout, stderr = sys.stdin.buffer, sys.stdout.buffer, sys.stderr
CHUNK = 262144  # 256KB streaming chunks

def log(msg):
    if os.environ.get('SSHGET_DEBUG'):
        stderr.write("[agent] {}\\n".format(msg))
        stderr.flush()

def read_exact(n):
    d = b''
    while len(d) < n:
        c = stdin.read(n - len(d))
        if not c:
            log("stdin closed, exiting (had {}/{} bytes)".format(len(d), n))
            sys.exit(0)
        d += c
    return d

def send_error(msg):
    err = msg.encode()[:1000]
    stdout.write(struct.pack('>BQ', 1, len(err)))
    stdout.write(err)
    stdout.flush()

def handle_request():
    # Read path length
    pl = struct.unpack('>H', read_exact(2))[0]

    # Read path
    path_bytes = read_exact(pl)
    try:
        path = path_bytes.decode('utf-8')
    except UnicodeDecodeError as e:
        send_error("Invalid path encoding: {}".format(e))
        return

    # Read offset and length
    off, ln = struct.unpack('>QQ', read_exact(16))
    log("request: {} offset={} len={}".format(path, off, ln))

    try:
        # Get actual file size to calculate real read length
        file_size = os.path.getsize(path)
        actual_len = min(ln, max(0, file_size - off))

        # Send success header with actual length
        stdout.write(struct.pack('>BQ', 0, actual_len))
        stdout.flush()

        if actual_len == 0:
            log("zero-length response")
            return

        # Stream data in chunks
        bytes_sent = 0
        with open(path, 'rb') as f:
            f.seek(off)
            remaining = actual_len
            while remaining > 0:
                chunk_size = min(CHUNK, remaining)
                data = f.read(chunk_size)
                if not data:
                    log("unexpected EOF at {}/{}".format(bytes_sent, actual_len))
                    break
                stdout.write(data)
                bytes_sent += len(data)
                remaining -= len(data)

        stdout.flush()
        log("sent {} bytes".format(bytes_sent))

    except Exception as e:
        log("error: {}".format(e))
        send_error(str(e))

# Main loop with top-level exception handling
while True:
    try:
        handle_request()
    except SystemExit:
        raise
    except Exception as e:
        log("fatal error in main loop: {}".format(e))
        # Try to send error, but don't die if that fails too
        try:
            send_error("Agent error: {}".format(e))
        except:
            pass
        sys.exit(1)
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
            fileLog("AgentPool", ...args)
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

        // Build remote command - set SSHGET_DEBUG for verbose agent logging
        const debugPrefix = this.verbose ? "SSHGET_DEBUG=1 " : ""
        args.push(`${debugPrefix}exec python3 -c ${shellEscape(PYTHON_AGENT)}`)

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
            const output = await this.execRemote('python3 -c "import sys; print(sys.version_info[0])"')
            const major = parseInt(output.trim(), 10)
            this.log(`Remote Python major version: ${major}`)
            if (major < 3) {
                throw new Error(`Python 3 is required on the remote server, but found Python ${major}`)
            }
        } catch (err) {
            if (err.message.includes("Python 3 is required")) {
                throw err
            }
            throw new Error("python3 is not available on the remote server")
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
                pendingRead: null,
                stderrBuffer: "" // Capture stderr for diagnostics
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

            const timeout = setTimeout(() => {
                reject(new Error(`Timeout waiting for agent ${index} to start`))
            }, 30000)

            proc.stderr.on("data", (data) => {
                const text = data.toString()
                agent.stderrBuffer += text
                // Keep buffer from growing unbounded
                if (agent.stderrBuffer.length > 10000) {
                    agent.stderrBuffer = agent.stderrBuffer.slice(-5000)
                }
                this.log(`Agent ${index} stderr:`, text.trim())
            })

            proc.on("error", (err) => {
                clearTimeout(timeout)
                reject(err)
            })

            proc.on("close", (code) => {
                clearTimeout(timeout)
                const stderr = agent.stderrBuffer.trim()
                if (!agent.ready) {
                    reject(new Error(`Agent ${index} exited with code ${code}: ${stderr}`))
                } else {
                    this.log(`Agent ${index} closed with code ${code}${stderr ? ` stderr: ${stderr}` : ""}`)
                    agent.ready = false
                    // Reject any pending read with an error so it doesn't wait forever
                    if (agent.pendingRead && agent.pendingRead.reject) {
                        const errMsg = `Agent ${index} connection closed (code ${code})${stderr ? `: ${stderr}` : ""}`
                        agent.pendingRead.reject(new Error(errMsg))
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
