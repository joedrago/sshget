import fs from "fs"
import { join } from "path"

let logStream = null
let logEnabled = false

export function initLogger(enabled = false, logPath = null) {
    logEnabled = enabled
    if (enabled) {
        const path = logPath || join(process.cwd(), ".sshget.log")
        logStream = fs.createWriteStream(path, { flags: "a" })
        log("--- Session started ---")
    }
}

export function log(prefix, ...args) {
    if (!logEnabled || !logStream) return

    const timestamp = new Date().toISOString()
    const message = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")

    logStream.write(`${timestamp} [${prefix}] ${message}\n`)
}

export function closeLogger() {
    if (logStream) {
        log("Logger", "--- Session ended ---")
        logStream.end()
        logStream = null
    }
}
