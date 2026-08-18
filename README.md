<div align="center">

# TAMGABASE

**Local-first Distributed Storage & Synchronization System**

[![NPM Version](https://img.shields.io/npm/v/@tamgallc/tamgabase.svg)](https://www.npmjs.com/package/@tamgallc/tamgabase)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

*TamgaBase is a standalone, Git-like, self-hosted data synchronization layer. It provides content-addressable storage (deduplication) and lightning-fast delta syncs directly over your local networks or VPS environments.*

</div>

## 🌟 Core Features

- **Content-Addressable Storage:** Files are deduplicated using SHA-256 hashes. If you push the same 1GB file from 10 different projects, TamgaBase stores it only once!
- **Smart Delta Sync (Push/Pull):** Before uploading, the client asks the server what it already has. It only uploads **new or changed files**, saving massive amounts of bandwidth.
- **Atomic Operations:** Immune to corruption. Files are written to temporary locations and atomically moved into place. Crash during an upload? No problem.
- **Bulletproof Architecture:** Settings and data are isolated from the code. You can update the CLI indefinitely without losing a single byte of configuration.
- **Cross-Platform:** Works flawlessly on Linux, macOS, and Windows.

---

## 🚀 Installation

TamgaBase is distributed as a global NPM package. Install it on any machine (Server or Client) using:

```bash
npm install -g @tamgallc/tamgabase
```
*(If you are on a Linux environment and get permission errors, use `sudo npm install -g @tamgallc/tamgabase`)*

---

## 🛠️ Usage Guide

TamgaBase operates in two distinct modes: **Server** (The central storage vault) and **Client** (The machine sending/receiving files).

### 1. Setting up the Server (Storage Vault)
Find a machine or VPS (like Ubuntu, AWS, etc.) that will host your data.

1. **Initialize the Server:**
   ```bash
   tamgabase init
   ```
   - Select **Server (Storage Backend)**.
   - Select **Re-displayable and rotatable** (recommended for ease of use).
   - The CLI will generate a secure **Server Key** (e.g., `tb_sk_...`). **Copy this key**, you will need it for your clients!

2. **Start the Server:**
   ```bash
   tamgabase server
   ```
   *Note: If you are on a Linux VPS, ensure port `7420` is open on your firewall (`sudo ufw allow 7420/tcp`).*

#### 💡 Pro-Tip: Running the Server 24/7 (Bulletproof Mode)
If you close the terminal, the server stops. To run it infinitely in the background, use `pm2`:
```bash
sudo npm install -g pm2
pm2 start tamgabase --name "TamgaServer" -- server
pm2 startup
pm2 save
```

---

### 2. Setting up the Client (Your Computer)
Navigate to the folder containing the project/files you want to sync.

1. **Initialize the Client:**
   ```bash
   tamgabase init
   ```
   - Select **Client (Sync Node)**.
   - Enter your Server's IP address (e.g., `13.50.234.159` or `localhost`).
   - Enter Port (`7420`).
   - Paste the **Server Key** you got from the server setup.

2. **Test your Connection (Heartbeat):**
   ```bash
   tamgabase heartbeat
   ```
   *This will continuously ping the server to ensure your connection and firewall are perfectly configured. Press `q` to stop.*

3. **Push Files to Server:**
   ```bash
   tamgabase push -m "My first backup"
   ```
   *TamgaBase will scan your folder, ignore locked/system files, calculate hashes, and upload ONLY the data the server doesn't already have.*

4. **Pull Files from Server:**
   Want to download your files to a different computer? Just run `tamgabase init` on the new computer as a Client, then:
   ```bash
   tamgabase pull
   ```

---

## 🔑 Key Management (Server only)

If you ever suspect your server key is compromised, you can rotate it. **Warning: This immediately disconnects all existing clients.**

```bash
# Show your current server key
tamgabase key show

# Rotate and generate a new key
tamgabase key rotate
```

---

## ⚙️ How it Works under the Hood

When you run `tamgabase push`:
1. **Scan:** The engine recursively scans your workspace.
2. **Hash:** Generates a SHA-256 hash for every file.
3. **Delta Check:** Sends an array of hashes to the server. The server replies with an array of hashes it *doesn't* have.
4. **Upload:** Only the missing files are uploaded into the server's `.tamgabase/data/objects/` directory.
5. **Snapshot:** A lightweight JSON file is created, mapping your folder's paths to their respective file hashes, and tagged as `latest`.

---

## 🔮 Future Roadmap (V2)
- **S3 Integration:** The `StorageBackend` abstraction is ready. Soon, you will be able to plug in AWS S3 or MinIO instead of Local Storage.
- **TCC Integration:** TamgaControlCenter will automatically use TamgaBase APIs to sync compute-node tasks without user intervention. 
