#!/usr/bin/env node

import { program } from "commander"
import { createInterface } from "readline"
import { existsSync, unlinkSync } from "fs"
import { SSHGet, ProgressDisplay } from "../lib/index.js"

function printUsage() {
    console.log(`Usage: sshget [options] <source...> <destination>

Download files/directories from remote servers via multiple parallel SSH connections.

Arguments:
  source...    One or more remote paths (user@host:path) - wildcards (*) supported
  destination  Local destination path

Options:
  -t, --tunnels <n>    Number of parallel SSH connections (default: 8)
  -P, --ssh-port <n>   Remote SSH port (default: 22)
  -i, --identity <key> SSH private key path
  --password           Prompt for password (uses sshpass)
  -c, --compress       Enable SSH compression
  -v, --verbose        Verbose output
  --no-progress        Disable progress display
  -h, --help           Display help

Examples:
  sshget user@host:file.txt .
  sshget user@host:dir/ ./local/
  sshget "user@host:*.txt" ./downloads/
  sshget user@host:file1 user@host:file2 ./dest/`)
}

// Check for no arguments or help
if (process.argv.length <= 2) {
    printUsage()
    process.exit(0)
}

program
    .name("sshget")
    .description("Download files/directories from remote servers via multiple parallel SSH connections")
    .argument("<paths...>", "Remote source(s) and local destination (last argument is destination)")
    .option("-t, --tunnels <n>", "Number of parallel SSH connections", (v) => parseInt(v, 10), 8)
    .option("-P, --ssh-port <n>", "Remote SSH port", (v) => parseInt(v, 10), 22)
    .option("-i, --identity <key>", "SSH private key path")
    .option("--password", "Prompt for password (uses sshpass)")
    .option("-c, --compress", "Enable SSH compression")
    .option("-v, --verbose", "Verbose output")
    .option("--no-progress", "Disable progress display")
    .action(async (paths, options) => {
        // Need at least 2 paths: source(s) and destination
        if (paths.length < 2) {
            console.error("Error: At least one source and a destination are required.")
            printUsage()
            process.exit(1)
        }

        const destination = paths[paths.length - 1]
        const sources = paths.slice(0, -1)

        // Check if destination looks like a remote source
        if (destination.includes("@") || destination.includes(":")) {
            console.error(`Error: Destination "${destination}" looks like a remote path.`)
            console.error('If you want to download to the current directory, use "." as the destination.')
            console.error("")
            console.error("Example: sshget user@host:file.txt .")
            process.exit(1)
        }

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
                sources,
                destination,
                tunnels: options.tunnels,
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
