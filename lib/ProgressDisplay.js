import chalk from "chalk"

export class ProgressDisplay {
    constructor(sshget, options = {}) {
        this.sshget = sshget
        this.verbose = options.verbose || false
        this.showTunnels = options.showTunnels !== false

        this.bytesReceived = 0
        this.totalBytes = 0
        this.currentFile = null
        this.filesCompleted = 0
        this.totalFiles = 0
        this.tunnelStates = []
        this.startTime = null
        this.lastRenderTime = 0
        this.renderInterval = 250

        this.speedBuckets = new Array(50).fill(0)
        this.bucketIndex = 0
        this.lastBucketTime = Date.now()
        this.bucketInterval = 100

        this.lineCount = 0
        this.attached = false

        this.attach()
    }

    attach() {
        if (this.attached) return
        this.attached = true

        this.sshget.on("start", (info) => {
            this.totalBytes = info.totalBytes
            this.totalFiles = info.totalFiles
            this.startTime = Date.now()
            this.render()
        })

        this.sshget.on("tunnel:status", (states) => {
            this.tunnelStates = states
            this.throttledRender()
        })

        this.sshget.on("file:start", (info) => {
            this.currentFile = info.file
            this.throttledRender()
        })

        this.sshget.on("file:progress", (info) => {
            this.updateSpeed(info.chunkBytes)
            this.bytesReceived += info.chunkBytes
            this.throttledRender()
        })

        this.sshget.on("file:complete", () => {
            this.filesCompleted++
            this.throttledRender()
        })

        this.sshget.on("complete", () => {
            this.render()
            this.cleanup()
            this.printSummary()
        })

        this.sshget.on("error", (err) => {
            this.cleanup()
            console.error(chalk.red(`\nError: ${err.message}`))
        })
    }

    updateSpeed(bytes) {
        const now = Date.now()
        const elapsed = now - this.lastBucketTime

        if (elapsed >= this.bucketInterval) {
            const bucketsToAdvance = Math.floor(elapsed / this.bucketInterval)
            for (let i = 0; i < bucketsToAdvance && i < this.speedBuckets.length; i++) {
                this.bucketIndex = (this.bucketIndex + 1) % this.speedBuckets.length
                this.speedBuckets[this.bucketIndex] = 0
            }
            this.lastBucketTime = now
        }

        this.speedBuckets[this.bucketIndex] += bytes
    }

    getSpeed() {
        const totalBytes = this.speedBuckets.reduce((a, b) => a + b, 0)
        const windowSeconds = (this.speedBuckets.length * this.bucketInterval) / 1000
        return totalBytes / windowSeconds
    }

    throttledRender() {
        const now = Date.now()
        if (now - this.lastRenderTime >= this.renderInterval) {
            this.render()
            this.lastRenderTime = now
        }
    }

    render() {
        this.clearLines()

        const lines = []

        const percent = this.totalBytes > 0 ? (this.bytesReceived / this.totalBytes) * 100 : 0
        const speed = this.getSpeed()
        const eta = speed > 0 ? (this.totalBytes - this.bytesReceived) / speed : 0

        const progressBar = this.createProgressBar(percent, 30)
        const speedStr = this.formatBytes(speed) + "/s"
        const etaStr = this.formatTime(eta)
        const bytesStr = `${this.formatBytes(this.bytesReceived)} / ${this.formatBytes(this.totalBytes)}`

        lines.push(`${progressBar} ${percent.toFixed(1)}% ${bytesStr} ${chalk.cyan(speedStr)} ETA: ${chalk.yellow(etaStr)}`)

        if (this.totalFiles > 1) {
            lines.push(chalk.dim(`Files: ${this.filesCompleted}/${this.totalFiles}`))
        }

        if (this.showTunnels && this.tunnelStates.length > 0) {
            lines.push("")
            lines.push(chalk.dim("Tunnels:"))
            for (const tunnel of this.tunnelStates) {
                const status = tunnel.busy ? chalk.green("●") : tunnel.ready ? chalk.dim("○") : chalk.red("○")
                const info = tunnel.jobInfo ? chalk.dim(` ${this.truncate(tunnel.jobInfo, 50)}`) : ""
                lines.push(`  ${status} Tunnel ${tunnel.id}${info}`)
            }
        }

        const output = lines.join("\n")
        process.stderr.write(output)
        this.lineCount = lines.length
    }

    createProgressBar(percent, width) {
        const filled = Math.round((percent / 100) * width)
        const empty = width - filled
        return chalk.green("█".repeat(filled)) + chalk.dim("░".repeat(empty))
    }

    clearLines() {
        if (this.lineCount > 0) {
            process.stderr.write(`\x1b[${this.lineCount}A\x1b[0J`)
        }
    }

    cleanup() {
        this.clearLines()
    }

    printSummary() {
        const elapsed = (Date.now() - this.startTime) / 1000
        const avgSpeed = elapsed > 0 ? this.bytesReceived / elapsed : 0

        console.log(
            chalk.green("✓") + ` Download complete: ${this.formatBytes(this.bytesReceived)} in ${this.formatTime(elapsed)}`
        )
        console.log(chalk.dim(`  Average speed: ${this.formatBytes(avgSpeed)}/s`))
        if (this.totalFiles > 1) {
            console.log(chalk.dim(`  Files: ${this.filesCompleted}`))
        }
    }

    formatBytes(bytes) {
        if (bytes === 0) return "0 B"
        const units = ["B", "KB", "MB", "GB", "TB"]
        const i = Math.floor(Math.log(bytes) / Math.log(1024))
        return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i]
    }

    formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return "--:--"
        const hrs = Math.floor(seconds / 3600)
        const mins = Math.floor((seconds % 3600) / 60)
        const secs = Math.floor(seconds % 60)
        if (hrs > 0) {
            return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
        }
        return `${mins}:${secs.toString().padStart(2, "0")}`
    }

    truncate(str, maxLen) {
        if (str.length <= maxLen) return str
        return str.slice(0, maxLen - 3) + "..."
    }
}
