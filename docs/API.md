# TamgaBase API Specification

The TamgaBase Server exposes two distinct APIs: **Management API** and **Data API**.

## 1. Management API
Used strictly for Server Administration.
**Authentication:** Bearer Token using the Server Key (`tb_sk_...`)

### `POST /api/v1/management/clusters`
- **Purpose:** Create a new Cluster.
- **Request Body:** `{ "cluster_id": "string", "storage_limit_bytes": number }`
- **Response:** `{ "cluster_id": "string", "access_key": "tb_cl_...", "storage_limit_bytes": number }`

### `GET /api/v1/management/clusters`
- **Purpose:** List all Clusters and their logical quota usage.

### `GET /api/v1/management/clusters/:clusterId`
- **Purpose:** Get specific Cluster details.

### `DELETE /api/v1/management/clusters/:clusterId`
- **Purpose:** Delete a cluster and its snapshots (Note: physical objects remain if shared).

### `POST /api/v1/management/clusters/:clusterId/rotate-key`
- **Purpose:** Invalidate the current cluster key and generate a new one.

---

## 2. Data API (Cluster Operations)
Used strictly for Data Synchronization (Push/Pull).
**Authentication:** Bearer Token using the specific Cluster Key (`tb_cl_...`). 
*Note: The cluster ID in the URL MUST match the cluster ID bound to the token.*

### `POST /api/v1/clusters/:clusterId/objects/check`
- **Purpose:** Check which object hashes are missing from the server.
- **Request Body:** `{ "hashes": ["hash1", "hash2"] }`
- **Response:** `{ "missing": ["hash1"] }`

### `POST /api/v1/clusters/:clusterId/objects/:hash`
- **Purpose:** Upload a new object. Validates quota before and after upload.
- **Body:** Binary Buffer
- **Response:** `201 Created`, `200 ignored` (object already exists), `400 Hash Mismatch`, or `402 Quota Exceeded`

### `GET /api/v1/clusters/:clusterId/objects/:hash`
- **Purpose:** Download an object.

### `POST /api/v1/clusters/:clusterId/snapshots/:id`
- **Purpose:** Save a new snapshot metadata file.

### `GET /api/v1/clusters/:clusterId/snapshots/:id`
- **Purpose:** Retrieve a snapshot metadata file.

---

## 3. Storage Backend Independence

The API is fully storage-agnostic. Every endpoint behaves identically regardless of whether the server
was started with `LocalStorageBackend` or `S3StorageBackend`:

| Endpoint | Local backend | S3 backend |
|----------|---------------|------------|
| Cluster CRUD / key rotation | same behavior | same behavior |
| objects/check, upload, download | same | same (atomic PUT/GET) |
| snapshots read/write | same | same (atomic PUT/GET) |
| Quota 402 / isolation 403 / hash 400 | same | same |

Failure mode differences:
- S3 outages surface as `500 {"error":"S3: ..."}` (mapped, no credentials in the message).
- Local backend I/O errors surface as `500 {"error":"..."}` as well.
- The server process never crashes on backend failures; `/api/v1/health` stays responsive.

## 4. Health
### `GET /api/v1/health`
- **Response:** `{ "status": "ok", "version": "1.3.0" }`
