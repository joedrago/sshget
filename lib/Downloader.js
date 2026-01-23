import fs from "fs"
import { mkdir } from "fs/promises"
import { dirname } from "path"

export class Downloader {
    constructor(options = {}) {
        this.verbose = options.verbose || false
    }

    log(...args) {
        if (this.verbose) {
            console.error("[Downloader]", ...args)
        }
    }

    async ensureDir(filePath) {
        const dir = dirname(filePath)
        await mkdir(dir, { recursive: true })
    }

    async downloadFile(options) {
        const { url, remotePath, localPath, onProgress } = options

        const tempPath = `${localPath}.sshget.tmp`

        await this.ensureDir(localPath)

        const fullUrl = `${url}${remotePath.startsWith("/") ? "" : "/"}${encodeURIComponent(remotePath).replace(/%2F/g, "/")}`

        this.log("Downloading:", fullUrl, "to", tempPath)

        const response = await fetch(fullUrl)

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        const fd = fs.openSync(tempPath, "w")
        let bytesWritten = 0

        try {
            for await (const chunk of response.body) {
                fs.writeSync(fd, chunk, 0, chunk.length, null)
                bytesWritten += chunk.length
                if (onProgress) {
                    onProgress(chunk.length)
                }
            }
        } finally {
            fs.closeSync(fd)
        }

        // Rename temp to final
        fs.renameSync(tempPath, localPath)

        this.log("Downloaded:", localPath, bytesWritten, "bytes")
        return { bytesReceived: bytesWritten }
    }

    async downloadRange(options) {
        const { url, remotePath, localPath, rangeStart, rangeEnd, onProgress } = options

        const tempPath = `${localPath}.sshget.tmp`

        await this.ensureDir(localPath)

        const fullUrl = `${url}${remotePath.startsWith("/") ? "" : "/"}${encodeURIComponent(remotePath).replace(/%2F/g, "/")}`

        this.log("Downloading range:", fullUrl, `bytes=${rangeStart}-${rangeEnd}`)

        const response = await fetch(fullUrl, {
            headers: { Range: `bytes=${rangeStart}-${rangeEnd}` }
        })

        if (response.status !== 206 && response.status !== 200) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        // Open temp file for random access writing at the chunk position
        const fd = fs.openSync(tempPath, "r+")
        let position = rangeStart
        let bytesWritten = 0

        try {
            for await (const chunk of response.body) {
                fs.writeSync(fd, chunk, 0, chunk.length, position)
                position += chunk.length
                bytesWritten += chunk.length
                if (onProgress) {
                    onProgress(chunk.length)
                }
            }
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

    async finalizeFile(localPath) {
        const tempPath = `${localPath}.sshget.tmp`
        fs.renameSync(tempPath, localPath)
        this.log("Finalized:", localPath)
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
