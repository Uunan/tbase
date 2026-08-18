# TamgaBase

TamgaBase is a standalone, Git-like, self-hosted data synchronization and storage system. It is designed to act as an internal storage/snapshot layer for TamgaControlCenter (TCC) in the future.

## Overview
- **Local-first**: Version 1 stores all data strictly on the local filesystem.
- **Content-Addressable**: Deduplicates identical objects (files) using SHA-256 hashes.
- **Git-like synchronization**: Pulls and Pushes compute the delta and transfer only missing objects.
- **Atomic Operations**: Employs temp files and atomic rename operations to prevent corruption.

## Installation
```bash
npm install -g tamgabase
# or build from source
npm run build
npm link
```

## Getting Started

### 1. Server Mode
Initialize the TamgaBase storage server on a machine:
```bash
tamgabase init
# Select "Server"
# Select your key policy
```

Start the server:
```bash
tamgabase server
```

### 2. Client Mode
Initialize a workspace to connect to the server:
```bash
tamgabase init
# Select "Client"
# Enter Server IP, Port, and Key
```

Push changes to the server:
```bash
tamgabase push -m "Initial snapshot"
```

Pull the latest snapshot from the server:
```bash
tamgabase pull
```

## Key Management
If the server is configured with the `rotatable` policy, you can view or rotate the key:
```bash
tamgabase key show
tamgabase key rotate
```
*Note: Rotating the key will instantly invalidate all existing clients.*

## Future Architecture
Currently, TamgaBase uses a `LocalStorageBackend`. The `StorageBackend` interface is abstracted to seamlessly integrate an S3-compatible backend (`S3StorageBackend`) in V2. TamgaControlCenter (TCC) will interact strictly with the local CLI APIs to push/pull job outputs without needing knowledge of the backend layer.
