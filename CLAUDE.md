# CLAUDE.md

This file provides context for Claude Code when working on this repository.

## Project Overview

sshget is a Node.js ES Module CLI tool that downloads files/directories from remote servers over HTTP via multiple parallel SSH tunnels. It's designed for fast parallel transfers by establishing multiple SSH connections and using HTTP Range requests to download file chunks concurrently.

## Architecture

```
sshget/
├── package.json          # ES module config, bin entry, exports
├── bin/
│   └── sshget.js         # CLI entry point (commander.js)
└── lib/
    ├── index.js          # Public exports
    ├── SSHGet.js         # Main orchestration class (EventEmitter)
    ├── TunnelPool.js     # SSH tunnel management
    ├── Downloader.js     # HTTP range request downloads
    └── ProgressDisplay.js # Terminal UI rendering
```

## Key Classes

### SSHGet (`lib/SSHGet.js`)

Main orchestration class extending EventEmitter. Coordinates tunnel pool, downloader, and emits progress events. Entry point is `download()` method.

### TunnelPool (`lib/TunnelPool.js`)

Manages SSH tunnel lifecycle:

- Spawns primary tunnel with embedded Python HTTP server (with Range support)
- Spawns N-1 secondary tunnels as port forwards only (`-N` flag)
- Handles sshpass integration for password auth
- Provides `acquire()`/`release()` for tunnel allocation
- Can execute remote commands via `execRemote()`
- Auto port detection: finds available ephemeral ports on local and remote sides
- Wildcard expansion via `expandWildcard()` for glob patterns

### Downloader (`lib/Downloader.js`)

Handles HTTP downloads:

- `downloadFile()` - whole file download
- `downloadRange()` - specific byte range download
- `preallocateFile()` - sparse file creation for chunked downloads
- Uses `.sshget.tmp` suffix for atomic renames

### ProgressDisplay (`lib/ProgressDisplay.js`)

Terminal UI that auto-attaches to SSHGet events:

- Rolling 5-second speed calculation (100ms buckets)
- Progress bars with percentage, bytes, speed, ETA
- Tunnel status display

## Embedded Python HTTP Server

Located in `TunnelPool.js` as `PYTHON_HTTP_SERVER` constant. Key features:

- `ThreadingHTTPServer` for parallel requests
- Range header parsing (bytes=start-end)
- Returns 206 Partial Content with Content-Range header
- Listens on 127.0.0.1 only (accessed via SSH tunnel)

## Commands

```bash
# Install dependencies
npm install

# Run linting
npm run lint

# Format code
npm run format

# Run CLI directly
node bin/sshget.js user@host:path

# Test library import
node -e "import { SSHGet } from 'sshget'; console.log(typeof SSHGet)"
```

## Code Style

- ES Modules (`"type": "module"`)
- No semicolons
- 4-space indentation
- 130 character line width
- No trailing commas
- ESLint with recommended rules
- Prettier for formatting

Always run `npm run lint` and `npm run format` after making changes.

## Key Implementation Details

### SSH Options

```javascript
-o Ciphers=aes128-gcm@openssh.com,aes256-gcm@openssh.com,aes128-ctr,aes256-ctr
-o IPQoS=throughput
-o ServerAliveInterval=60
-o ExitOnForwardFailure=yes
-o StrictHostKeyChecking=accept-new
```

### Chunking Strategy

Files >= 50MB with multiple tunnels are split:

```javascript
const chunkSize = Math.ceil(fileSize / numTunnels)
// Each tunnel downloads one chunk via Range request
```

### Tunnel Setup

1. Primary tunnel: `ssh -tt -L localPort:127.0.0.1:remotePort user@host 'exec python3 -c "..."'`
2. Secondary tunnels: `ssh -N -L localPort:127.0.0.1:remotePort user@host`

The `-tt` flag forces PTY allocation, which ensures the remote Python server receives SIGHUP when the SSH connection drops. The `exec` prefix replaces the shell process with Python, ensuring clean termination.

### Port Allocation

Default is "auto" which:

1. Finds an available remote port using Python socket binding
2. Finds available local ports for each tunnel using Node.js net.Server

Fixed port mode allocates sequential ports: basePort, basePort+1, ..., basePort+N-1

### Graceful Shutdown

On SIGINT/SIGTERM:

1. Aborts download and collects list of active temp files
2. Deletes all `.sshget.tmp` files being written
3. Closes all SSH tunnels
4. Exits cleanly

### Wildcard Support

Remote paths can contain `*` and `?` wildcards. The pattern is expanded on the remote side using shell globbing before download begins.

## Testing

No automated tests yet. Manual testing:

```bash
# Basic file download
sshget user@host:path/to/file.txt

# Directory download
sshget user@host:path/to/dir ./local/dir

# Verbose output
sshget -v user@host:path/to/large.iso

# Custom tunnel count
sshget -t 8 user@host:path/to/file

# Wildcard pattern (downloads all matching files)
sshget user@host:*.txt

# Fixed port instead of auto
sshget -p 12346 user@host:path/to/file

# Ctrl+C gracefully cleans up temp files
```

## Dependencies

Runtime:

- `commander` - CLI argument parsing
- `chalk` - Terminal colors

Dev:

- `eslint` - Linting
- `prettier` - Code formatting
- `@eslint/js` - ESLint recommended config
- `globals` - Global variable definitions for ESLint
