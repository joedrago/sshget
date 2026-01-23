#!/usr/bin/env node

import { program } from "commander"
import { createInterface } from "readline"
import { existsSync, unlinkSync } from "fs"
import { SSHGet, ProgressDisplay } from "../lib/index.js"

function parsePort(value) {
    if (value === "auto") return "auto"
    const parsed = parseInt(value, 10)
    if (isNaN(parsed)) {
        throw new Error(`Invalid port: ${value}`)
    }
    return parsed
}

program
    .name("sshget")
    .description("Download files/directories from remote servers over HTTP via multiple parallel SSH tunnels")
    .argument("<source>", "Remote path (user@host:path) - wildcards (*) supported")
    .argument("[destination]", "Local path", process.cwd())
    .option("-t, --tunnels <n>", "Number of parallel tunnels", parseInt, 8)
    .option("-p, --port <port>", "Local/remote port for HTTP server (auto = find available)", parsePort, "auto")
    .option("-P, --ssh-port <n>", "Remote SSH port", parseInt, 22)
    .option("-i, --identity <key>", "SSH private key path")
    .option("--password", "Prompt for password (uses sshpass)")
    .option("-c, --compress", "Enable SSH compression")
    .option("-v, --verbose", "Verbose output")
    .option("--no-progress", "Disable progress display")
    .action(async (source, destination, options) => {
        let sshget = null
        let display = null
        let shuttingDown = false

        // Graceful shutdown handler (like whatsync)
        const shutdown = async () => {
            if (shuttingDown) return
            shuttingDown = true

            if (display) {
                display.stop()
            }

            console.log("\nAborting, cleaning up...")

            if (sshget) {
                // Abort returns list of temp files to clean up
                const tempFiles = sshget.abort()

                // Clean up temp files
                for (const tempPath of tempFiles) {
                    try {
                        if (existsSync(tempPath)) {
                            unlinkSync(tempPath)
                        }
                    } catch (_err) {
                        // Ignore cleanup errors
                    }
                }

                // Close tunnels
                try {
                    await sshget.cleanup()
                } catch (_err) {
                    // Ignore cleanup errors
                }
            }

            process.exit(0)
        }

        process.on("SIGINT", shutdown)
        process.on("SIGTERM", shutdown)

        try {
            let password = null

            if (options.password) {
                password = await promptPassword()
            }

            sshget = new SSHGet({
                source,
                destination,
                tunnels: options.tunnels,
                basePort: options.port,
                sshPort: options.sshPort,
                privateKey: options.identity,
                password,
                compress: options.compress,
                verbose: options.verbose
            })

            if (options.progress !== false) {
                display = new ProgressDisplay(sshget, {
                    verbose: options.verbose,
                    showTunnels: options.verbose
                })
            }

            await sshget.download()
        } catch (err) {
            if (shuttingDown) return // Don't report errors during shutdown

            if (options.verbose) {
                console.error(err)
            } else {
                console.error(`Error: ${err.message}`)
            }
            process.exit(1)
        }
    })

async function promptPassword() {
    return new Promise((resolve) => {
        const rl = createInterface({
            input: process.stdin,
            output: process.stderr
        })

        process.stderr.write("Password: ")

        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true)
        }

        let password = ""

        process.stdin.on("data", (char) => {
            const c = char.toString()

            if (c === "\n" || c === "\r" || c === "\u0004") {
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(false)
                }
                process.stderr.write("\n")
                rl.close()
                resolve(password)
            } else if (c === "\u0003") {
                process.exit(1)
            } else if (c === "\u007f" || c === "\b") {
                password = password.slice(0, -1)
            } else {
                password += c
            }
        })
    })
}

program.parse()
