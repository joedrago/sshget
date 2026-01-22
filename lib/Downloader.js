import { createWriteStream } from "fs"
import { open, rename, unlink, mkdir } from "fs/promises"
import { dirname } from "path"
import http from "http"

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

        return new Promise((resolve, reject) => {
            const request = http.get(fullUrl, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
                    return
                }

                const totalSize = parseInt(response.headers["content-length"], 10) || 0
                let receivedBytes = 0

                const fileStream = createWriteStream(tempPath)

                response.on("data", (chunk) => {
                    receivedBytes += chunk.length
                    if (onProgress) {
                        onProgress(chunk.length, receivedBytes, totalSize)
                    }
                })

                response.pipe(fileStream)

                fileStream.on("finish", async () => {
                    fileStream.close()
                    try {
                        await rename(tempPath, localPath)
                        resolve({ bytesReceived: receivedBytes })
                    } catch (err) {
                        reject(err)
                    }
                })

                fileStream.on("error", async (err) => {
                    fileStream.close()
                    try {
                        await unlink(tempPath)
                    } catch (_e) {
                        // Ignore cleanup errors
                    }
                    reject(err)
                })

                response.on("error", async (err) => {
                    fileStream.close()
                    try {
                        await unlink(tempPath)
                    } catch (_e) {
                        // Ignore cleanup errors
                    }
                    reject(err)
                })
            })

            request.on("error", reject)
        })
    }

    async downloadRange(options) {
        const { url, remotePath, localPath, rangeStart, rangeEnd, onProgress } = options

        const tempPath = `${localPath}.sshget.tmp`

        await this.ensureDir(localPath)

        const fullUrl = `${url}${remotePath.startsWith("/") ? "" : "/"}${encodeURIComponent(remotePath).replace(/%2F/g, "/")}`

        this.log("Downloading range:", fullUrl, `bytes=${rangeStart}-${rangeEnd}`)

        return new Promise((resolve, reject) => {
            const urlObj = new URL(fullUrl)

            const requestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname + urlObj.search,
                headers: {
                    Range: `bytes=${rangeStart}-${rangeEnd}`
                }
            }

            const request = http.get(requestOptions, async (response) => {
                if (response.statusCode !== 206 && response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
                    return
                }

                let receivedBytes = 0
                const expectedBytes = rangeEnd - rangeStart + 1

                try {
                    const fd = await open(tempPath, "r+")
                    let currentPosition = rangeStart

                    response.on("data", async (chunk) => {
                        try {
                            await fd.write(chunk, 0, chunk.length, currentPosition)
                            currentPosition += chunk.length
                            receivedBytes += chunk.length
                            if (onProgress) {
                                onProgress(chunk.length, receivedBytes, expectedBytes)
                            }
                        } catch (err) {
                            response.destroy()
                            await fd.close()
                            reject(err)
                        }
                    })

                    response.on("end", async () => {
                        await fd.close()
                        resolve({ bytesReceived: receivedBytes })
                    })

                    response.on("error", async (err) => {
                        await fd.close()
                        reject(err)
                    })
                } catch (err) {
                    reject(err)
                }
            })

            request.on("error", reject)
        })
    }

    async preallocateFile(localPath, size) {
        const tempPath = `${localPath}.sshget.tmp`

        await this.ensureDir(localPath)

        const fd = await open(tempPath, "w")

        if (size > 0) {
            const buffer = Buffer.alloc(1)
            await fd.write(buffer, 0, 1, size - 1)
        }

        await fd.close()

        this.log("Preallocated sparse file:", tempPath, "size:", size)
    }

    async finalizeFile(localPath) {
        const tempPath = `${localPath}.sshget.tmp`
        await rename(tempPath, localPath)
        this.log("Finalized:", localPath)
    }

    async cleanupTemp(localPath) {
        const tempPath = `${localPath}.sshget.tmp`
        try {
            await unlink(tempPath)
        } catch (_e) {
            // Ignore if temp file doesn't exist
        }
    }
}
