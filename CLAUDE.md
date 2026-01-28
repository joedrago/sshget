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
    ├── AgentPool.js      # SSH agent connection management
    ├── Downloader.js     # File downloads via agent protocol
    └── ProgressDisplay.js # Terminal UI rendering
```

## Key Classes

### SSHGet (`lib/SSHGet.js`)

Main orchestration class extending EventEmitter. Coordinates tunnel pool, downloader, and emits progress events. Entry point is `download()` method.

### AgentPool (`lib/AgentPool.js`)

Manages SSH agent connections:

- Spawns N SSH connections, each running an embedded Python agent
- Binary protocol over stdin/stdout (no HTTP, no port forwarding)
- Handles sshpass integration for password auth
- Provides `acquire()`/`release()` for agent allocation
- `readRangeStreaming()` for efficient byte-range file reads
- Can execute remote commands via `execRemote()` for file listings
- Wildcard expansion via `expandWildcard()` for glob patterns

### Downloader (`lib/Downloader.js`)

Handles file downloads via agent protocol:

- `downloadFile()` - whole file download
- `downloadRange()` - specific byte range download
- `preallocateFile()` - sparse file creation for chunked downloads
- Uses `.sshget.tmp` suffix for atomic renames

### ProgressDisplay (`lib/ProgressDisplay.js`)

Terminal UI that auto-attaches to SSHGet events:

- Rolling 5-second speed calculation (100ms buckets)
- Progress bars with percentage, bytes, speed, ETA
- Tunnel status display

## Embedded Python Agent

Located in `AgentPool.js` as `PYTHON_AGENT` constant. Key features:

- Minimal binary protocol over stdin/stdout
- Request: `path_len(2) + path + offset(8) + length(8)`
- Response: `status(1) + data_len(8) + data`
- No ports, no HTTP overhead - direct streaming through SSH channel

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

### Agent Setup

Each agent: `ssh -T user@host 'exec python3 -c "AGENT_CODE"'`

The `-T` flag disables PTY allocation, which is required for the binary protocol (PTY would corrupt binary data). The agent exits cleanly when stdin closes (SSH disconnect). The `exec` prefix replaces the shell process with Python.

No port allocation is needed - all communication happens over the SSH stdin/stdout channel.

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
