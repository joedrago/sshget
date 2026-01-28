import fs from "fs"
import { mkdir } from "fs/promises"
import { dirname } from "path"
import { log as fileLog } from "./Logger.js"

export class Downloader {
    constructor(options = {}) {
        this.verbose = options.verbose || false
    }

    log(...args) {
        if (this.verbose) {
            fileLog("Downloader", ...args)
        }
    }

    async ensureDir(filePath) {
        const dir = dirname(filePath)
        await mkdir(dir, { recursive: true })
    }

    async downloadFile(options) {
        const { agentPool, agent, remotePath, localPath, fileSize, mode, mtime, onProgress } = options

        const tempPath = `${localPath}.sshget.tmp`

        await this.ensureDir(localPath)

        this.log("Downloading:", remotePath, "to", tempPath)

        const fd = fs.openSync(tempPath, "w")
        let bytesWritten = 0

        try {
            await agentPool.readRangeStreaming(agent, remotePath, 0, fileSize, (chunk) => {
                fs.writeSync(fd, chunk, 0, chunk.length, null)
                bytesWritten += chunk.length
                if (onProgress) {
                    onProgress(chunk.length)
                }
            })
        } finally {
            fs.closeSync(fd)
        }

        // Rename temp to final
        fs.renameSync(tempPath, localPath)

        // Preserve permissions and timestamps
        this.applyMetadata(localPath, mode, mtime)

        this.log("Downloaded:", localPath, bytesWritten, "bytes")
        return { bytesReceived: bytesWritten }
    }

    async downloadRange(options) {
        const { agentPool, agent, remotePath, localPath, rangeStart, rangeEnd, onProgress } = options

        const tempPath = `${localPath}.sshget.tmp`

        await this.ensureDir(localPath)

        const length = rangeEnd - rangeStart + 1

        this.log("Downloading range:", remotePath, `bytes=${rangeStart}-${rangeEnd}`)

        // Open temp file for random access writing at the chunk position
        const fd = fs.openSync(tempPath, "r+")
        let position = rangeStart
        let bytesWritten = 0

        try {
            await agentPool.readRangeStreaming(agent, remotePath, rangeStart, length, (chunk) => {
                fs.writeSync(fd, chunk, 0, chunk.length, position)
                position += chunk.length
                bytesWritten += chunk.length
                if (onProgress) {
                    onProgress(chunk.length)
                }
            })
        } finally {
            fs.closeSync(fd)
        }

        this.log("Downloaded range:", rangeStart, "-", rangeEnd, ":", bytesWritten, "bytes")
        return { bytesReceived: bytesWritten }
    }

    async preallocateFile(localPath, size) {
        const tempPath = `${localPath}.sshget.tmp`

        await this.ensureDir(localPath)

        // Use ftruncateSync to create a sparse file of the correct size
        const fd = fs.openSync(tempPath, "w")
        fs.ftruncateSync(fd, size)
        fs.closeSync(fd)

        this.log("Preallocated sparse file:", tempPath, "size:", size)
    }

    async finalizeFile(localPath, mode, mtime) {
        const tempPath = `${localPath}.sshget.tmp`
        fs.renameSync(tempPath, localPath)

        // Preserve permissions and timestamps
        this.applyMetadata(localPath, mode, mtime)

        this.log("Finalized:", localPath)
    }

    applyMetadata(localPath, mode, mtime) {
        try {
            if (mode !== undefined) {
                fs.chmodSync(localPath, mode)
            }
            if (mtime !== undefined) {
                // utimesSync takes atime and mtime in seconds
                const mtimeDate = new Date(mtime * 1000)
                fs.utimesSync(localPath, mtimeDate, mtimeDate)
            }
        } catch (err) {
            this.log("Warning: could not set metadata for", localPath, err.message)
        }
    }

    async cleanupTemp(localPath) {
        const tempPath = `${localPath}.sshget.tmp`
        try {
            fs.unlinkSync(tempPath)
        } catch (_e) {
            // Ignore if temp file doesn't exist
        }
    }
}
