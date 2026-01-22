import { EventEmitter } from "events"
import { join, basename } from "path"
import { TunnelPool } from "./TunnelPool.js"
import { Downloader } from "./Downloader.js"

export class SSHGet extends EventEmitter {
    constructor(options = {}) {
        super()

        if (!options.source) {
            throw new Error("source is required")
        }

        const parsed = this.parseSource(options.source)
        this.user = parsed.user
        this.host = parsed.host
        this.remotePath = parsed.path

        this.destination = options.destination || process.cwd()
        this.tunnelCount = options.tunnels || 4
        this.basePort = options.basePort || 12346
        this.compress = options.compress || false
        this.password = options.password || null
        this.privateKey = options.privateKey || null
        this.sshPort = options.sshPort || 22
        this.verbose = options.verbose || false
        this.parallelThreshold = options.parallelThreshold || 50 * 1024 * 1024

        this.tunnelPool = null
        this.downloader = null
        this.aborted = false
        this.files = []
        this.totalBytes = 0
        this.bytesReceived = 0
        this.activeJobs = new Map()
    }

    parseSource(source) {
        const match = source.match(/^(?:([^@]+)@)?([^:]+):(.+)$/)
        if (!match) {
            throw new Error(`Invalid source format: ${source}. Expected: [user@]host:path`)
        }
        return {
            user: match[1] || process.env.USER || "root",
            host: match[2],
            path: match[3]
        }
    }

    log(...args) {
        if (this.verbose) {
            console.error("[SSHGet]", ...args)
        }
    }

    async download() {
        try {
            this.log("Starting download from", `${this.user}@${this.host}:${this.remotePath}`)

            this.tunnelPool = new TunnelPool({
                user: this.user,
                host: this.host,
                remotePath: this.getRemoteBaseDir(),
                tunnels: this.tunnelCount,
                basePort: this.basePort,
                compress: this.compress,
                password: this.password,
                privateKey: this.privateKey,
                sshPort: this.sshPort,
                verbose: this.verbose
            })

            this.downloader = new Downloader({
                verbose: this.verbose
            })

            this.tunnelPool.on("tunnel:status", (states) => {
                this.emit("tunnel:status", states)
            })

            this.log("Connecting tunnel pool...")
            await this.tunnelPool.connect()

            this.emit("tunnel:ready")
            this.log("Tunnel pool connected")

            this.log("Listing remote files...")
            this.files = await this.tunnelPool.listRemoteFiles(this.remotePath)

            if (this.files.length === 0) {
                throw new Error(`No files found at ${this.remotePath}`)
            }

            this.totalBytes = this.files.reduce((sum, f) => sum + f.size, 0)

            this.log(`Found ${this.files.length} files, ${this.totalBytes} bytes total`)

            this.emit("start", {
                totalBytes: this.totalBytes,
                totalFiles: this.files.length,
                files: this.files
            })

            await this.downloadFiles()

            this.emit("complete", {
                bytesReceived: this.bytesReceived,
                files: this.files.length
            })

            await this.tunnelPool.close()

            return {
                bytesReceived: this.bytesReceived,
                files: this.files.length
            }
        } catch (err) {
            this.emit("error", err)
            await this.cleanup()
            throw err
        }
    }

    getRemoteBaseDir() {
        const parts = this.remotePath.split("/")
        parts.pop()
        const dir = parts.join("/")
        // For relative paths (no leading /), use current dir if no parent
        if (!dir && !this.remotePath.startsWith("/")) {
            return "."
        }
        return dir || "/"
    }

    getLocalPath(file) {
        if (this.files.length === 1) {
            const destName = this.destination.endsWith("/") ? join(this.destination, basename(file.path)) : this.destination
            return destName
        }
        return join(this.destination, file.path)
    }

    async downloadFiles() {
        const jobs = []

        for (const file of this.files) {
            const localPath = this.getLocalPath(file)
            const remotePath = basename(file.fullPath)

            if (file.size >= this.parallelThreshold && this.tunnelCount > 1) {
                const chunkSize = Math.ceil(file.size / this.tunnelCount)
                for (let i = 0; i < this.tunnelCount; i++) {
                    const rangeStart = i * chunkSize
                    const rangeEnd = Math.min((i + 1) * chunkSize - 1, file.size - 1)
                    jobs.push({
                        type: "range",
                        file,
                        localPath,
                        remotePath,
                        rangeStart,
                        rangeEnd,
                        chunkIndex: i
                    })
                }
            } else {
                jobs.push({
                    type: "file",
                    file,
                    localPath,
                    remotePath
                })
            }
        }

        const preallocFiles = new Set()
        for (const job of jobs) {
            if (job.type === "range" && !preallocFiles.has(job.localPath)) {
                preallocFiles.add(job.localPath)
                await this.downloader.preallocateFile(job.localPath, job.file.size)
            }
        }

        const pendingJobs = [...jobs]
        const runningJobs = new Map()
        const completedChunks = new Map()

        const runJob = async (job) => {
            const tunnel = this.tunnelPool.acquire()
            if (!tunnel) return false

            runningJobs.set(job, tunnel.id)

            const jobInfo =
                job.type === "range"
                    ? `${basename(job.remotePath)} [${job.chunkIndex + 1}/${this.tunnelCount}]`
                    : basename(job.remotePath)

            this.tunnelPool.setJobInfo(tunnel.id, jobInfo)

            this.emit("file:start", { file: job.file.path, job })

            try {
                if (job.type === "range") {
                    await this.downloader.downloadRange({
                        url: tunnel.url,
                        remotePath: job.remotePath,
                        localPath: job.localPath,
                        rangeStart: job.rangeStart,
                        rangeEnd: job.rangeEnd,
                        fileSize: job.file.size,
                        onProgress: (chunkBytes) => {
                            this.bytesReceived += chunkBytes
                            this.emit("file:progress", {
                                file: job.file.path,
                                chunkBytes,
                                bytesReceived: this.bytesReceived,
                                totalBytes: this.totalBytes
                            })
                        }
                    })

                    const key = job.localPath
                    const chunks = completedChunks.get(key) || new Set()
                    chunks.add(job.chunkIndex)
                    completedChunks.set(key, chunks)

                    if (chunks.size === this.tunnelCount) {
                        await this.downloader.finalizeFile(job.localPath)
                        this.emit("file:complete", { file: job.file.path })
                    }
                } else {
                    await this.downloader.downloadFile({
                        url: tunnel.url,
                        remotePath: job.remotePath,
                        localPath: job.localPath,
                        onProgress: (chunkBytes) => {
                            this.bytesReceived += chunkBytes
                            this.emit("file:progress", {
                                file: job.file.path,
                                chunkBytes,
                                bytesReceived: this.bytesReceived,
                                totalBytes: this.totalBytes
                            })
                        }
                    })

                    this.emit("file:complete", { file: job.file.path })
                }
            } finally {
                runningJobs.delete(job)
                this.tunnelPool.release(tunnel.id)
            }

            return true
        }

        while (pendingJobs.length > 0 || runningJobs.size > 0) {
            if (this.aborted) {
                throw new Error("Download aborted")
            }

            while (pendingJobs.length > 0 && runningJobs.size < this.tunnelCount) {
                const job = pendingJobs.shift()
                runJob(job).catch((err) => {
                    this.log("Job error:", err.message)
                })
            }

            await new Promise((resolve) => setTimeout(resolve, 50))
        }
    }

    abort() {
        this.aborted = true
        this.cleanup()
    }

    async cleanup() {
        if (this.tunnelPool) {
            await this.tunnelPool.close()
        }

        for (const file of this.files) {
            const localPath = this.getLocalPath(file)
            await this.downloader?.cleanupTemp(localPath)
        }
    }
}
