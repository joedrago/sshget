# sshget

Download files and directories from remote servers over HTTP via multiple parallel SSH tunnels.

## Features

- **Parallel SSH tunnels** - Establish multiple SSH connections for concurrent downloads
- **Range request support** - Large files are split into chunks and downloaded in parallel
- **Progress display** - Real-time progress with speed, ETA, and tunnel status
- **Directory support** - Download entire directory trees
- **Library API** - Use as a module in your own projects

## Installation

Install globally from GitHub:

```bash
npm install -g github:yourusername/sshget
```

Or clone and link locally:

```bash
git clone https://github.com/yourusername/sshget.git
cd sshget
npm install
npm link
```

Or run directly with npx:

```bash
npx github:yourusername/sshget user@host:path/to/file
```

## CLI Usage

```
Usage: sshget [options] <source> [destination]

Arguments:
  source                Remote path (user@host:path)
  destination           Local path (default: current directory)

Options:
  -t, --tunnels <n>     Number of parallel tunnels (default: 8)
  -p, --port <n>        Starting local port (default: 12346)
  -P, --ssh-port <n>    Remote SSH port (default: 22)
  -i, --identity <key>  SSH private key path
  --password            Prompt for password (uses sshpass)
  -c, --compress        Enable SSH compression
  -v, --verbose         Verbose output
  --no-progress         Disable progress display
  -h, --help            Show help
```

### Examples

Download a single file:

```bash
sshget user@example.com:path/to/file.iso ./downloads/
```

Download a directory:

```bash
sshget user@example.com:path/to/dir ./local-dir
```

Use 8 parallel tunnels for faster downloads:

```bash
sshget -t 8 user@example.com:large-file.iso
```

Use a specific SSH key:

```bash
sshget -i ~/.ssh/mykey user@example.com:file.txt
```

Use password authentication (requires sshpass):

```bash
sshget --password user@example.com:file.txt
```

## Library Usage

```javascript
import { SSHGet, ProgressDisplay } from "sshget"

const transfer = new SSHGet({
    source: "user@example.com:path/to/files",
    destination: "./downloads",
    tunnels: 4
})

// Optional: attach progress display
new ProgressDisplay(transfer)

// Listen to events
transfer.on("progress", ({ bytesReceived, totalBytes, speed }) => {
    console.log(`${bytesReceived}/${totalBytes} @ ${speed}/s`)
})

transfer.on("complete", () => {
    console.log("Done!")
})

await transfer.download()
```

### SSHGet Options

| Option              | Type    | Default         | Description                              |
| ------------------- | ------- | --------------- | ---------------------------------------- |
| `source`            | string  | required        | Remote path in format `[user@]host:path` |
| `destination`       | string  | `process.cwd()` | Local destination path                   |
| `tunnels`           | number  | `8`             | Number of parallel SSH tunnels           |
| `basePort`          | number  | `12346`         | Starting local port for tunnels          |
| `compress`          | boolean | `false`         | Enable SSH compression                   |
| `password`          | string  | `null`          | SSH password (requires sshpass)          |
| `privateKey`        | string  | `null`          | Path to SSH private key                  |
| `sshPort`           | number  | `22`            | Remote SSH port                          |
| `verbose`           | boolean | `false`         | Enable debug logging                     |
| `parallelThreshold` | number  | `52428800`      | Chunk files larger than this (50MB)      |

### Events

| Event           | Payload                                           | Description              |
| --------------- | ------------------------------------------------- | ------------------------ |
| `start`         | `{ totalBytes, totalFiles, files }`               | Download beginning       |
| `tunnel:ready`  | -                                                 | All tunnels established  |
| `tunnel:status` | `[{ id, port, ready, busy, jobInfo }]`            | Tunnel state changes     |
| `file:start`    | `{ file, job }`                                   | Starting a file download |
| `file:progress` | `{ file, chunkBytes, bytesReceived, totalBytes }` | Bytes received           |
| `file:complete` | `{ file }`                                        | File finished            |
| `complete`      | `{ bytesReceived, files }`                        | All downloads finished   |
| `error`         | `Error`                                           | Error occurred           |

## How It Works

1. **SSH tunnel establishment** - Creates N SSH connections to the remote server
2. **Python HTTP server** - Spawns a Python HTTP server on the remote that supports Range requests
3. **Port forwarding** - Each tunnel forwards a local port to the remote HTTP server
4. **Parallel downloads** - Files are downloaded through the tunnels in parallel
5. **Chunked transfers** - Large files (>50MB) are split into chunks, one per tunnel

The embedded Python HTTP server supports HTTP Range requests, allowing sshget to download different parts of a file simultaneously through different tunnels.

## Requirements

- Node.js 18+
- SSH access to the remote server
- Python 3 on the remote server
- `sshpass` (only if using `--password` option)

### Installing sshpass

**macOS:**

```bash
brew install hudochenkov/sshpass/sshpass
```

**Ubuntu/Debian:**

```bash
sudo apt-get install sshpass
```

## Development

```bash
# Clone the repository
git clone https://github.com/your-username/sshget.git
cd sshget

# Install dependencies
npm install

# Run linting
npm run lint

# Format code
npm run format
```

## License

MIT
