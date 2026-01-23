#!/usr/bin/env node

import { program } from "commander"
import { createInterface } from "readline"
import { SSHGet, ProgressDisplay } from "../lib/index.js"

program
    .name("sshget")
    .description("Download files/directories from remote servers over HTTP via multiple parallel SSH tunnels")
    .argument("<source>", "Remote path (user@host:path)")
    .argument("[destination]", "Local path", process.cwd())
    .option("-t, --tunnels <n>", "Number of parallel tunnels", parseInt, 8)
    .option("-p, --port <n>", "Starting local port", parseInt, 12346)
    .option("-P, --ssh-port <n>", "Remote SSH port", parseInt, 22)
    .option("-i, --identity <key>", "SSH private key path")
    .option("--password", "Prompt for password (uses sshpass)")
    .option("-c, --compress", "Enable SSH compression")
    .option("-v, --verbose", "Verbose output")
    .option("--no-progress", "Disable progress display")
    .action(async (source, destination, options) => {
        try {
            let password = null

            if (options.password) {
                password = await promptPassword()
            }

            const sshget = new SSHGet({
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
                new ProgressDisplay(sshget, {
                    verbose: options.verbose,
                    showTunnels: options.verbose
                })
            }

            await sshget.download()
        } catch (err) {
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
