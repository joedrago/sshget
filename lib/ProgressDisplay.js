import chalk from "chalk"

export class ProgressDisplay {
    constructor(sshget, options = {}) {
        this.sshget = sshget
        this.verbose = options.verbose || false
        this.showTunnels = options.showTunnels !== false

        // Source/destination for header
        const paths = sshget.remotePaths
        if (paths.length === 1) {
            this.source = `${sshget.user}@${sshget.host}:${paths[0]}`
        } else {
            this.source = `${sshget.user}@${sshget.host}: (${paths.length} sources)`
        }
        this.destination = sshget.destination

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

        this.recentFiles = []
        this.maxRecentFiles = 5

        this.remotePort = null

        this.attached = false
        this.finished = false

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

        this.sshget.on("tunnel:ready", (info) => {
            this.remotePort = info?.remotePort
            this.throttledRender()
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

        this.sshget.on("file:complete", (info) => {
            this.filesCompleted++
            this.recentFiles.unshift(info.file)
            if (this.recentFiles.length > this.maxRecentFiles) {
                this.recentFiles.pop()
            }
            this.throttledRender()
        })

        this.sshget.on("complete", () => {
            this.finished = true
            this.printSummary()
        })

        this.sshget.on("error", (err) => {
            this.finished = true
            this.clearScreen()
            console.error(chalk.red(`Error: ${err.message}`))
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

    clearScreen() {
        process.stdout.write("\x1B[2J\x1B[H")
    }

    render() {
        if (this.finished) return

        this.clearScreen()

        const percent = this.totalBytes > 0 ? (this.bytesReceived / this.totalBytes) * 100 : 0
        const speed = this.getSpeed()
        const eta = speed > 0 ? (this.totalBytes - this.bytesReceived) / speed : 0

        const progressBar = this.createProgressBar(percent, 40)
        const speedStr = this.formatBytes(speed) + "/s"
        const etaStr = this.formatTime(eta)

        console.log()
        console.log(`  ${chalk.cyan(this.source)} ${chalk.dim("→")} ${chalk.green(this.destination)}`)
        console.log()
        console.log(`  ${progressBar} ${percent.toFixed(1)}%`)
        console.log()
        console.log(`  Progress: ${this.formatBytes(this.bytesReceived)} / ${this.formatBytes(this.totalBytes)}`)
        console.log(`  Speed   : ${chalk.cyan(speedStr)}`)
        console.log(`  ETA     : ${chalk.yellow(etaStr)}`)

        if (this.totalFiles > 1) {
            console.log(`  Files   : ${this.filesCompleted}/${this.totalFiles}`)
        }

        if (this.showTunnels && this.tunnelStates.length > 0) {
            console.log()
            const portInfo = this.remotePort ? chalk.dim(` (HTTP :${this.remotePort})`) : ""
            console.log(chalk.dim("  Tunnels:") + portInfo)
            for (const tunnel of this.tunnelStates) {
                const status = tunnel.busy ? chalk.green("●") : tunnel.ready ? chalk.dim("○") : chalk.red("○")
                const portLabel = chalk.dim(`[${tunnel.port}]`)
                const info = tunnel.jobInfo ? chalk.dim(` ${this.truncate(tunnel.jobInfo, 45)}`) : ""
                console.log(`    ${status} Tunnel ${tunnel.id} ${portLabel}${info}`)
            }
        }

        if (this.recentFiles.length > 0) {
            console.log()
            console.log(chalk.dim("  Recent:"))
            for (const file of this.recentFiles) {
                console.log(chalk.dim(`    ${chalk.green("✓")} ${this.truncate(file, 60)}`))
            }
        }
    }

    createProgressBar(percent, width) {
        const filled = Math.round((percent / 100) * width)
        const empty = width - filled
        return chalk.green("█".repeat(filled)) + chalk.dim("░".repeat(empty))
    }

    printSummary() {
        this.clearScreen()

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

    stop() {
        this.finished = true
        this.clearScreen()
    }
}
