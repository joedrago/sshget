import { EventEmitter } from "events"
import { join, basename } from "path"
import { existsSync, statSync, unlinkSync } from "fs"
import { TunnelPool } from "./TunnelPool.js"
import { Downloader } from "./Downloader.js"

export class SSHGet extends EventEmitter {
    constructor(options = {}) {
        super()

        // Accept either 'sources' array or legacy 'source' string
        const sourceList = options.sources || (options.source ? [options.source] : [])
        if (sourceList.length === 0) {
            throw new Error("At least one source is required")
        }

        // Parse all sources
        this.parsedSources = sourceList.map((s) => this.parseSource(s))

        // Validate all sources are from the same host (for now)
        const firstHost = `${this.parsedSources[0].user}@${this.parsedSources[0].host}`
        for (const parsed of this.parsedSources) {
            const thisHost = `${parsed.user}@${parsed.host}`
            if (thisHost !== firstHost) {
                throw new Error(`All sources must be from the same host. Got ${firstHost} and ${thisHost}`)
            }
        }

        this.user = this.parsedSources[0].user
        this.host = this.parsedSources[0].host
        this.remotePaths = this.parsedSources.map((p) => p.path)

        this.destination = options.destination || process.cwd()
        this.tunnelCount = options.tunnels || 8
        this.basePort = options.basePort ?? "auto"
        this.compress = options.compress || false
        this.password = options.password || null
        this.privateKey = options.privateKey || null
        this.sshPort = options.sshPort || 22
        this.verbose = options.verbose || false
        this.parallelThreshold = options.parallelThreshold || 50 * 1024 * 1024

        this.tunnelPool = null
        this.downloader = null
        this.aborted = false
        this.isDirectory = false
        this.isWildcard = false // Track if any source had wildcards
        this.files = []
        this.totalBytes = 0
        this.bytesReceived = 0
        this.activeJobs = new Map()
        this.activeTempFiles = new Set() // Track temp files being written to
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

    hasWildcard(path) {
        return path.includes("*") || path.includes("?")
    }

    async download() {
        try {
            this.log("Starting download from", `${this.user}@${this.host}`)
            this.log("Sources:", this.remotePaths)

            // Expand wildcards for all remote paths
            let expandedPaths = []
            const needsWildcardExpansion = this.remotePaths.some((p) => this.hasWildcard(p))

            if (needsWildcardExpansion) {
                // Create a temporary tunnel pool just for wildcard expansion (uses execRemote, no connect needed)
                const tempPool = new TunnelPool({
                    user: this.user,
                    host: this.host,
                    remotePath: ".",
                    tunnels: 1,
                    basePort: this.basePort,
                    compress: this.compress,
                    password: this.password,
                    privateKey: this.privateKey,
                    sshPort: this.sshPort,
                    verbose: this.verbose
                })

                for (const remotePath of this.remotePaths) {
                    if (this.hasWildcard(remotePath)) {
                        this.isWildcard = true
                        this.log("Expanding wildcard pattern:", remotePath)
                        const expanded = await tempPool.expandWildcard(remotePath)
                        if (expanded.length === 0) {
                            throw new Error(`No files match pattern: ${remotePath}`)
                        }
                        this.log("Expanded to:", expanded)
                        expandedPaths.push(...expanded)
                    } else {
                        expandedPaths.push(remotePath)
                    }
                }
            } else {
                expandedPaths = [...this.remotePaths]
            }

            // Get the base directory for the HTTP server
            const baseDir = this.getRemoteBaseDirForPaths(expandedPaths)

            this.tunnelPool = new TunnelPool({
                user: this.user,
                host: this.host,
                remotePath: baseDir,
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

            this.emit("tunnel:ready", { remotePort: this.tunnelPool.remotePort })
            this.log("Tunnel pool connected")

            this.log("Listing remote files...")
            // Collect files from all expanded paths, tracking which root each file came from
            this.files = []
            let hasDirectory = false
            for (const expandedPath of expandedPaths) {
                const pathInfo = await this.tunnelPool.getRemotePathInfo(expandedPath)
                const isDir = pathInfo.isDirectory
                if (isDir) hasDirectory = true
                const filesForPath = await this.tunnelPool.listRemoteFiles(expandedPath)
                // Tag each file with its matched root and whether that root was a directory
                for (const file of filesForPath) {
                    file.matchedRoot = expandedPath
                    file.matchedRootIsDir = isDir
                }
                this.files.push(...filesForPath)
            }
            this.isDirectory = hasDirectory || expandedPaths.length > 1

            if (this.files.length === 0) {
                throw new Error(`No files found matching sources`)
            }

            this.totalBytes = this.files.reduce((sum, f) => sum + f.size, 0)

            this.log(`Found ${this.files.length} files, ${this.totalBytes} bytes total`)

            this.emit("start", {
                totalBytes: this.totalBytes,
                totalFiles: this.files.length,
                files: this.files
            })

            const result = await this.downloadFiles()

            // If aborted, don't emit complete - just clean up quietly
            if (result?.aborted) {
                return { aborted: true }
            }

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
            // Don't emit error if we were aborted
            if (!this.aborted) {
                this.emit("error", err)
            }
            await this.cleanup()
            throw err
        }
    }

    getRemoteBaseDirForPaths(paths) {
        if (paths.length === 1) {
            const parts = paths[0].split("/")
            parts.pop()
            const dir = parts.join("/")
            if (!dir && !paths[0].startsWith("/")) {
                return "."
            }
            return dir || "/"
        }

        // Find common prefix directory for multiple paths
        const splitPaths = paths.map((p) => p.split("/"))
        const minLen = Math.min(...splitPaths.map((p) => p.length))

        let commonParts = []
        for (let i = 0; i < minLen - 1; i++) {
            const part = splitPaths[0][i]
            if (splitPaths.every((p) => p[i] === part)) {
                commonParts.push(part)
            } else {
                break
            }
        }

        if (commonParts.length === 0) {
            return paths[0].startsWith("/") ? "/" : "."
        }

        return commonParts.join("/") || "/"
    }

    getLocalPath(file) {
        const hasMultipleSources = this.remotePaths.length > 1

        // Single source, single file, not a wildcard - can use destination as filename
        if (this.files.length === 1 && !this.isDirectory && !this.isWildcard && !hasMultipleSources) {
            // If destination is an existing directory or ends with /, put file inside it
            const destIsDir =
                this.destination.endsWith("/") || (existsSync(this.destination) && statSync(this.destination).isDirectory())
            if (destIsDir) {
                return join(this.destination, basename(file.path))
            }
            // Otherwise use destination as the filename
            return this.destination
        }

        // Multiple sources, wildcards, or directories - use matchedRoot to determine path
        if (file.matchedRootIsDir) {
            // Source was a directory - preserve structure under that directory name
            // e.g., source is mtg/, file is mtg/subdir/file.txt
            // → destination/mtg/subdir/file.txt
            const dirName = basename(file.matchedRoot)
            return join(this.destination, dirName, file.path)
        } else {
            // Source was a file directly - put flat in destination
            // e.g., source is foo.txt → destination/foo.txt
            return join(this.destination, basename(file.fullPath))
        }
    }

    async downloadFiles() {
        const jobs = []

        for (const file of this.files) {
            const localPath = this.getLocalPath(file)
            const remotePath = file.fullPath

            if (file.size >= this.parallelThreshold && this.tunnelCount > 1) {
                const chunkSize = Math.ceil(file.size / this.tunnelCount)
                let actualChunkCount = 0
                for (let i = 0; i < this.tunnelCount; i++) {
                    const rangeStart = i * chunkSize
                    const rangeEnd = Math.min((i + 1) * chunkSize - 1, file.size - 1)
                    // Guard against edge case where rangeStart > rangeEnd
                    if (rangeStart <= rangeEnd) {
                        jobs.push({
                            type: "range",
                            file,
                            localPath,
                            remotePath,
                            rangeStart,
                            rangeEnd,
                            chunkIndex: actualChunkCount,
                            totalChunks: 0 // Will be set after loop
                        })
                        actualChunkCount++
                    }
                }
                // Set actual chunk count on all range jobs for this file
                for (const job of jobs) {
                    if (job.type === "range" && job.localPath === localPath) {
                        job.totalChunks = actualChunkCount
                    }
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
                const tempPath = `${job.localPath}.sshget.tmp`
                this.activeTempFiles.add(tempPath)
                await this.downloader.preallocateFile(job.localPath, job.file.size)
            }
        }

        const pendingJobs = [...jobs]
        const activeJobs = new Map() // tunnel.id -> job
        const completedChunks = new Map()
        const jobRetries = new Map()
        const failedJobs = [] // Track permanently failed jobs
        const maxRetries = 3

        let resolveAll
        let rejectAll
        const allDone = new Promise((resolve, reject) => {
            resolveAll = resolve
            rejectAll = reject
        })

        const processQueue = () => {
            if (this.aborted) {
                resolveAll({ aborted: true })
                return
            }

            // Start jobs for available tunnels
            while (pendingJobs.length > 0) {
                const tunnel = this.tunnelPool.acquire()
                if (!tunnel) break

                const job = pendingJobs.shift()
                activeJobs.set(tunnel.id, job)

                const jobInfo =
                    job.type === "range"
                        ? `${basename(job.remotePath)} [${job.chunkIndex + 1}/${job.totalChunks}]`
                        : basename(job.remotePath)

                this.tunnelPool.setJobInfo(tunnel.id, jobInfo)
                this.emit("file:start", { file: job.file.path, job })

                executeJob(tunnel, job)
            }

            // Check if all done
            if (pendingJobs.length === 0 && activeJobs.size === 0) {
                resolveAll()
            }
        }

        const executeJob = async (tunnel, job) => {
            const tempPath = `${job.localPath}.sshget.tmp`

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

                    if (chunks.size === job.totalChunks) {
                        await this.downloader.finalizeFile(job.localPath, job.file.mode, job.file.mtime)
                        this.activeTempFiles.delete(tempPath)
                        this.emit("file:complete", { file: job.file.path })
                    }
                } else {
                    // Track temp file for whole-file downloads
                    this.activeTempFiles.add(tempPath)

                    await this.downloader.downloadFile({
                        url: tunnel.url,
                        remotePath: job.remotePath,
                        localPath: job.localPath,
                        mode: job.file.mode,
                        mtime: job.file.mtime,
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

                    // downloadFile does its own rename, so remove from tracking
                    this.activeTempFiles.delete(tempPath)
                    this.emit("file:complete", { file: job.file.path })
                }

                onJobComplete(tunnel, job)
            } catch (err) {
                onJobFailed(tunnel, job, err)
            }
        }

        const onJobComplete = (tunnel, _job) => {
            activeJobs.delete(tunnel.id)
            this.tunnelPool.release(tunnel.id)
            processQueue()
        }

        const onJobFailed = (tunnel, job, err) => {
            activeJobs.delete(tunnel.id)
            this.tunnelPool.release(tunnel.id)

            const retries = (jobRetries.get(job) || 0) + 1
            jobRetries.set(job, retries)

            if (retries < maxRetries) {
                this.log("Job error (retry", retries + "/" + maxRetries + "):", err.message)
                pendingJobs.push(job)
                processQueue()
            } else {
                this.log("Job failed after", maxRetries, "retries:", job.remotePath, err.message)
                failedJobs.push(job)
                const jobDesc =
                    job.type === "range" ? `${job.remotePath} chunk ${job.chunkIndex + 1}/${job.totalChunks}` : job.remotePath
                rejectAll(new Error(`Download failed: ${jobDesc} - ${err.message}`))
            }
        }

        // Start processing
        processQueue()

        // Wait for all jobs to complete and return result
        return await allDone
    }

    abort() {
        this.aborted = true
        // Return list of temp files to clean up (like whatsync)
        const tempFiles = Array.from(this.activeTempFiles)
        this.activeTempFiles.clear()
        return tempFiles
    }

    async cleanup() {
        if (this.tunnelPool) {
            await this.tunnelPool.close()
        }

        // Clean up any tracked active temp files
        for (const tempPath of this.activeTempFiles) {
            try {
                unlinkSync(tempPath)
            } catch (_e) {
                // Ignore if temp file doesn't exist
            }
        }
        this.activeTempFiles.clear()

        // Also clean up based on file list (legacy behavior)
        for (const file of this.files) {
            const localPath = this.getLocalPath(file)
            await this.downloader?.cleanupTemp(localPath)
        }
    }
}
