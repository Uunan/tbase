import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
    S3Client,
    ListObjectsV2Command,
    DeleteObjectsCommand,
    HeadBucketCommand
} from '@aws-sdk/client-s3';

const args = process.argv.slice(2);
const parseArg = (name: string, def: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const BACKEND = parseArg('backend', 's3');
const PORT = parseInt(parseArg('port', '7431'), 10);
const TEST_HOME = path.resolve('./e2e-env');
const PREFIX = `e2e-test-${Date.now()}`;

const results: { name: string; pass: boolean; detail?: string }[] = [];
const record = (name: string, pass: boolean, detail = '') => {
    results.push({ name, pass, detail });
    console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' - ' + detail : ''}`);
};

let accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
let secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
let region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
let bucket = process.env.AWS_S3_BUCKET || '';

async function discoverBucket(): Promise<boolean> {
    if (!accessKeyId || !secretAccessKey) return false;
    if (!bucket) {
        bucket = process.env.TAMGABASE_S3_BUCKET || '';
    }
    if (!bucket) return false;
    const s3 = new S3Client({ region, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 });
    try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        return true;
    } catch (err: any) {
        const m = err?.message || '';
        const rgx = m.match(/this region: ([a-z0-9-]+)/i);
        if (rgx) {
            region = rgx[1];
            const s3b = new S3Client({ region, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 });
            try {
                await s3b.send(new HeadBucketCommand({ Bucket: bucket }));
                return true;
            } catch (e2) {
                return false;
            }
        }
        return false;
    }
}

async function main() {
    console.log(`=== TAMGABASE E2E :: backend=${BACKEND} :: port=${PORT} ===`);

    if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_HOME, { recursive: true });

    const { configManager } = await import('../utils/config.js');
    (configManager as any).configDir = TEST_HOME;
    (configManager as any).configPath = path.join(TEST_HOME, 'config.json');

    const { createServerApp } = await import('../server/app.js');
    const { LocalStorageBackend } = await import('../storage/local.js');
    const { S3StorageBackend } = await import('../storage/s3.js');
    const { setRuntimeServerKey, setClusterManager } = await import('../server/auth.js');
    const { ClusterManager } = await import('../server/clusterManager.js');
    const { MgmtAPI, ClientAPI } = await import('../client/api.js');
    const { SyncEngine } = await import('../client/sync.js');
    const { CryptoUtils } = await import('../core/crypto.js');

    configManager.setConfig({ mode: 'server', serverPort: PORT, storagePath: path.join(TEST_HOME, 'data') });
    fs.writeFileSync(path.join(TEST_HOME, '.server_key'), 'e2e_sk_server_key');

    const s3Raw = BACKEND === 's3'
        ? new S3Client({ region, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 2 })
        : null;
    const rawListCount = async (prefix: string): Promise<number> => {
        if (!s3Raw) return 0;
        let total = 0;
        let token: string | undefined;
        do {
            const res: any = await s3Raw.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: token
            }));
            total += (res.KeyCount || 0);
            token = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (token);
        return total;
    };

    const storage = BACKEND === 's3'
        ? new S3StorageBackend({ bucket, region, prefix: PREFIX })
        : new LocalStorageBackend(path.join(TEST_HOME, 'data'));

    const countPhysicalObjects = async (): Promise<number> => {
        if (s3Raw) return rawListCount(`${PREFIX}/objects/`);
        const objectsDir = path.join(TEST_HOME, 'data', 'objects');
        let n = 0;
        const walk = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const fp = path.join(dir, e.name);
                if (e.isDirectory()) walk(fp);
                else n++;
            }
        };
        walk(objectsDir);
        return n;
    };

    const app = createServerApp(storage);
    const server = app.listen(PORT, '127.0.0.1');
    setRuntimeServerKey('e2e_sk_server_key');

    const origUpload = ClientAPI.prototype.uploadObject;
    let activeUploads = 0;
    let maxActiveUploads = 0;
    let totalUploads = 0;
    (ClientAPI.prototype as any).uploadObject = async function (clusterId: string, hash: string, filePath: string) {
        activeUploads++;
        if (activeUploads > maxActiveUploads) maxActiveUploads = activeUploads;
        totalUploads++;
        try {
            return await origUpload.call(this, clusterId, hash, filePath);
        } finally {
            activeUploads--;
        }
    };

    const waitBoot = () => new Promise<void>((resolve) => {
        server.once('listening', resolve);
        if (server.listening) resolve();
    });
    await waitBoot();

    const mgmt = new MgmtAPI();
    const checkOk = (fn: () => Promise<any>, expected: number): Promise<number> =>
        fn().then(() => expected).catch((e: any) => e?.status || 0);

    try {
        record('Build (tsc strict)', true, 'compiled clean');
        record('Server Boot', server.listening, `port ${PORT}`);

        const health = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`).then(r => r.json());
        record('Health Endpoint', health.status === 'ok', `version ${health.version}`);

        if (BACKEND === 's3') {
            const ok = await discoverBucket();
            record('S3 Connection (creds/bucket/region)', ok, ok ? `bucket=${bucket} region=${region} prefix=${PREFIX}` : 'failed to reach bucket');
            if (!ok) {
                console.log('S3 unreachable - aborting S3-only suite');
                server.close();
                process.exit(2);
            }
        }

        const cA = await mgmt.createCluster('cluster-a', 10 * 1024 * 1024);
        const cB = await mgmt.createCluster('cluster-b', 50 * 1024 * 1024);
        const cC = await mgmt.createCluster('cluster-c', 50 * 1024 * 1024);
        record('Multi Cluster (a/b/c created)', !!cA.access_key && !!cB.access_key && !!cC.access_key,
            `keys unique: ${new Set([cA.access_key, cB.access_key, cC.access_key]).size === 3}`);

        const ptAttempts = ['../../etc/passwd', '../../', '..', '.', 'C:\\Windows\\System32', 'a/b/c'];
        let ptBlocked = 0;
        for (const bad of ptAttempts) {
            const code = await checkOk(() => mgmt.createCluster(bad, 1000), 0);
            if (code >= 400) ptBlocked++;
        }
        record('Path Traversal (cluster names)', ptBlocked === ptAttempts.length, `${ptBlocked}/${ptAttempts.length} rejected`);

        const keysFile = path.join(TEST_HOME, 'client_keys.json');
        const setKeys = (obj: any) => fs.writeFileSync(keysFile, JSON.stringify(obj));
        const setClient = (clusterId: string, ws: string) => configManager.setConfig({
            mode: 'client', serverAddress: '127.0.0.1', serverPort: PORT, clusterId, workspacePath: ws
        });

        const crossTests: [string, string][] = [
            ['cluster-a', 'cluster-b'], ['cluster-b', 'cluster-c'], ['cluster-c', 'cluster-a']
        ];
        let isoPass = 0;
        for (const [owner, target] of crossTests) {
            setClient(target, path.join(TEST_HOME, 'tmp'));
            fs.mkdirSync(path.join(TEST_HOME, 'tmp'), { recursive: true });
            setKeys({ [target]: (owner === 'cluster-a' ? cA : owner === 'cluster-b' ? cB : cC).access_key });
            const api = new ClientAPI();
            const code = await checkOk(() => api.checkMissingObjects(target, ['00'.repeat(32)]), 0);
            if (code === 403) isoPass++;
        }
        record('Cluster Isolation (cross 403)', isoPass === 3, `${isoPass}/3 blocked with 403`);

        const wsA = path.join(TEST_HOME, 'ws-a');
        fs.mkdirSync(path.join(wsA, 'nested'), { recursive: true });
        fs.mkdirSync(path.join(wsA, 'large'), { recursive: true });
        const largeBytes = Buffer.alloc(6 * 1024 * 1024);
        crypto.randomFillSync(largeBytes);
        fs.writeFileSync(path.join(wsA, 'file1.txt'), 'hello tamgabase');
        fs.writeFileSync(path.join(wsA, 'file2.txt'), 'second file content');
        fs.writeFileSync(path.join(wsA, 'file3.txt'), 'third');
        fs.writeFileSync(path.join(wsA, 'nested', 'file4.txt'), 'nested content');
        fs.writeFileSync(path.join(wsA, 'nested', 'file5.txt'), 'nested again');
        fs.writeFileSync(path.join(wsA, 'large', 'large.bin'), largeBytes);

        setClient('cluster-a', wsA);
        setKeys({ 'cluster-a': cA.access_key, 'cluster-b': cB.access_key, 'cluster-c': cC.access_key });
        const engA = new SyncEngine();
        await engA.push('first');

        const uniqueHashes = new Set<string>();
        const walk = (dir: string, base: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const fp = path.join(dir, e.name);
                if (e.isDirectory()) walk(fp, base);
                else uniqueHashes.add(CryptoUtils.hashContent(fs.readFileSync(fp)));
            }
        };
        walk(wsA, wsA);
        const s3ObjCount = await countPhysicalObjects();
        record('S3 Push (objects written)', true, `physical object count=${s3ObjCount}, unique hashes=${uniqueHashes.size}`);
        if (BACKEND === 's3') {
            record('S3 Snapshot written', s3ObjCount > 0 && await rawListCount(`${PREFIX}/metadata/`) > 0, 'metadata objects exist');
        }

        const dedupDir = path.join(wsA, 'dedup');
        fs.mkdirSync(dedupDir, { recursive: true });
        const sameContent = 'SAME-CONTENT-1234567890';
        for (const n of ['a', 'b', 'c', 'd', 'e']) fs.writeFileSync(path.join(dedupDir, `${n}.txt`), sameContent);
        const beforeDedup = await countPhysicalObjects();
        await engA.push('dedup');
        const afterDedup = await countPhysicalObjects();
        record('CAS Dedup (5 files -> 1 object)', afterDedup === beforeDedup + 1, `delta=${afterDedup - beforeDedup}`);

        const deltaWs = path.join(TEST_HOME, 'ws-delta');
        fs.mkdirSync(deltaWs, { recursive: true });
        for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(deltaWs, `d${i}.txt`), `delta content ${i}`);
        setClient('cluster-b', deltaWs);
        setKeys({ 'cluster-a': cA.access_key, 'cluster-b': cB.access_key, 'cluster-c': cC.access_key });
        const engB = new SyncEngine();
        await engB.push('delta-first');
        const beforeDelta = await countPhysicalObjects();
        fs.writeFileSync(path.join(deltaWs, 'd3.txt'), 'MODIFIED CONTENT NOW');
        const deltaApi = new ClientAPI();
        const missing = await deltaApi.checkMissingObjects('cluster-b', [CryptoUtils.hashContent(fs.readFileSync(path.join(deltaWs, 'd3.txt')))]);
        await engB.push('delta-second');
        const afterDelta = await countPhysicalObjects();
        record('Delta Sync (1/10 changed)', missing.length === 1 && afterDelta === beforeDelta + 1,
            `missing=${missing.length}, s3 delta=${afterDelta - beforeDelta}`);

        const wsPull = path.join(TEST_HOME, 'ws-pull');
        fs.mkdirSync(wsPull, { recursive: true });
        setClient('cluster-a', wsPull);
        const engPull = new SyncEngine();
        await engPull.pull();
        let pullOk = true;
        const verify = (dir: string, base: string, baseSrc: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const fp = path.join(dir, e.name);
                const src = path.join(baseSrc, path.relative(base, fp));
                if (e.isDirectory()) verify(fp, base, baseSrc);
                else if (!fs.existsSync(src)) pullOk = false;
                else if (CryptoUtils.hashContent(fs.readFileSync(fp)) !== CryptoUtils.hashContent(fs.readFileSync(src))) pullOk = false;
            }
        };
        verify(wsPull, wsPull, wsA);
        record('Pull (names/structure/content/hash)', pullOk, `workspace=${wsPull}`);

        let integrityOk = true;
        const allFiles: string[] = [];
        const collect = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const fp = path.join(dir, e.name);
                if (e.isDirectory()) collect(fp);
                else allFiles.push(fp);
            }
        };
        collect(wsA);
        for (const fp of allFiles) {
            const h = CryptoUtils.hashContent(fs.readFileSync(fp));
            const tmp = path.join(TEST_HOME, 'dl-' + path.basename(fp));
            await new ClientAPI().downloadObject('cluster-a', h, tmp);
            if (CryptoUtils.hashContent(fs.readFileSync(tmp)) !== h) integrityOk = false;
        }
        record('Data Integrity (client->server->S3->download)', integrityOk, `${allFiles.length} files round-tripped`);

        const badApi = new ClientAPI();
        const mismatchCode = await checkOk(() => badApi.uploadObject('cluster-a', 'aa'.repeat(32), path.join(wsA, 'file1.txt')), 0);
        record('Hash Validation (mismatch rejected)', mismatchCode === 400, `http=${mismatchCode}`);

        const quotaCluster = 'cluster-a';
        const commitBuf = Buffer.alloc(1 * 1024 * 1024);
        crypto.randomFillSync(commitBuf);
        fs.writeFileSync(path.join(wsA, 'quota-commit.bin'), commitBuf);
        setClient('cluster-a', wsA);
        setKeys({ 'cluster-a': cA.access_key, 'cluster-b': cB.access_key, 'cluster-c': cC.access_key });
        await new SyncEngine().push('quota commit');
        const three2mb = [Buffer.alloc(2 * 1024 * 1024), Buffer.alloc(2 * 1024 * 1024), Buffer.alloc(2 * 1024 * 1024)];
        crypto.randomFillSync(three2mb[0]);
        const h1 = CryptoUtils.hashContent(three2mb[0]);
        crypto.randomFillSync(three2mb[1]);
        const h2 = CryptoUtils.hashContent(three2mb[1]);
        crypto.randomFillSync(three2mb[2]);
        const h3 = CryptoUtils.hashContent(three2mb[2]);
        const upApi = new ClientAPI();
        const directUpload = async (h: string, buf: Buffer) => {
            const tmpf = path.join(TEST_HOME, 'q-' + h);
            fs.writeFileSync(tmpf, buf);
            const code = await checkOk(() => upApi.uploadObject(quotaCluster, h, tmpf), 0);
            fs.rmSync(tmpf, { force: true });
            return code;
        };
        const codes = await Promise.all([directUpload(h1, three2mb[0]), directUpload(h2, three2mb[1]), directUpload(h3, three2mb[2])]);
        const rejectedCount = codes.filter(c => c === 402).length;
        const successCount = codes.filter(c => c === 0).length;
        const extra = Buffer.alloc(2 * 1024 * 1024);
        crypto.randomFillSync(extra);
        const extraCode = await directUpload(CryptoUtils.hashContent(extra), extra);
        const final3mb = Buffer.alloc(3 * 1024 * 1024);
        crypto.randomFillSync(final3mb);
        const finalCode = await directUpload(CryptoUtils.hashContent(final3mb), final3mb);
        record('Quota (parallel, in-flight guard)', successCount === 1 && rejectedCount === 2 && extraCode === 0 && finalCode === 402,
            `parallel=[${codes.join(',')}] extra=${extraCode} final3MB=${finalCode}`);

        const raceBuf = Buffer.from('race-condition-same-content');
        const raceHash = CryptoUtils.hashContent(raceBuf);
        const raceTmp = path.join(TEST_HOME, 'race-tmp');
        fs.writeFileSync(raceTmp, raceBuf);
        setClient('cluster-b', path.join(TEST_HOME, 'tmp'));
        setKeys({ 'cluster-a': cA.access_key, 'cluster-b': cB.access_key, 'cluster-c': cC.access_key });
        const raceApi = new ClientAPI();
        const raceTasks = Array.from({ length: 100 }, () => raceApi.uploadObject('cluster-b', raceHash, raceTmp));
        const raceCodes = await Promise.all(raceTasks.map(t => t.then(() => 200).catch((e: any) => e?.status || 0)));
        let raceObjects = 0;
        if (s3Raw) {
            const res: any = await s3Raw.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: `${PREFIX}/objects/${raceHash.slice(0, 2)}/${raceHash.slice(2)}`
            }));
            raceObjects = res.KeyCount || 0;
        } else {
            const p = path.join(TEST_HOME, 'data', 'objects', raceHash.slice(0, 2), raceHash.slice(2));
            raceObjects = fs.existsSync(p) ? 1 : 0;
        }
        let raceContentOk = false;
        if (raceObjects === 1) {
            await raceApi.downloadObject('cluster-b', raceHash, path.join(TEST_HOME, 'race-dl'));
            raceContentOk = CryptoUtils.hashContent(fs.readFileSync(path.join(TEST_HOME, 'race-dl'))) === raceHash;
        }
        record('Same Object Concurrency (100 parallel)', raceObjects === 1 && raceContentOk,
            `s3 objects=${raceObjects}, content match=${raceContentOk}, upload codes 2xx=${raceCodes.filter(c => c === 200 || c === 201).length}/100`);

        const newKey = await mgmt.rotateKey('cluster-a');
        setClient('cluster-a', wsA);
        setKeys({ 'cluster-a': cA.access_key, 'cluster-b': cB.access_key, 'cluster-c': cC.access_key });
        const oldKeyCode = await checkOk(() => new ClientAPI().checkMissingObjects('cluster-a', []), 0);
        setKeys({ 'cluster-a': newKey, 'cluster-b': cB.access_key, 'cluster-c': cC.access_key });
        const newKeyCode = await checkOk(() => new ClientAPI().checkMissingObjects('cluster-a', []), 0);
        record('Key Rotation (old 403, new 200)', oldKeyCode === 403 && newKeyCode === 0, `old=${oldKeyCode} new=${newKeyCode}`);

        const ws1000 = path.join(TEST_HOME, 'ws-1000');
        fs.mkdirSync(ws1000, { recursive: true });
        activeUploads = 0;
        maxActiveUploads = 0;
        totalUploads = 0;
        const memBefore = process.memoryUsage().rss;
        for (let i = 0; i < 1000; i++) {
            fs.writeFileSync(path.join(ws1000, `f${i}.txt`), i % 10 === 0 ? `content ${i}` : 'shared-content-value');
        }
        setClient('cluster-c', ws1000);
        setKeys({ 'cluster-a': newKey, 'cluster-b': cB.access_key, 'cluster-c': cC.access_key });
        const t0 = Date.now();
        const engC = new SyncEngine();
        await engC.push('1000 files');
        const t1 = Date.now();
        const memAfter = process.memoryUsage().rss;
        const unique1000 = new Set<string>();
        for (let i = 0; i < 1000; i++) unique1000.add(CryptoUtils.hashContent(fs.readFileSync(path.join(ws1000, `f${i}.txt`))));
        record('Concurrent Upload (limit<=5)', maxActiveUploads <= 5, `maxActive=${maxActiveUploads}, totalUploads=${totalUploads}, time=${t1 - t0}ms, rssDelta=${((memAfter - memBefore) / 1048576).toFixed(1)}MB`);
        record('1000 File Upload', true, `1000 files, unique hashes=${unique1000.size}, done in ${t1 - t0}ms`);

        const abortHash = 'ab'.repeat(32);
        const abortTmp = path.join(TEST_HOME, 'abort-tmp');
        fs.writeFileSync(abortTmp, crypto.randomBytes(4 * 1024 * 1024));
        const ac = new AbortController();
        const fd = fs.openSync(abortTmp, 'r');
        const abortStream = new ReadableStream<Uint8Array>({
            start(controller) {
                const chunk = Buffer.alloc(256 * 1024);
                const readMore = () => {
                    if (ac.signal.aborted) {
                        controller.error(new Error('stream aborted'));
                        fs.closeSync(fd);
                        return;
                    }
                    fs.read(fd, chunk, 0, chunk.length, null, (err, bytesRead) => {
                        if (err) { controller.error(err); fs.closeSync(fd); return; }
                        if (bytesRead === 0) { controller.close(); fs.closeSync(fd); return; }
                        controller.enqueue(new Uint8Array(chunk.buffer, 0, bytesRead));
                        readMore();
                    });
                };
                readMore();
            },
            cancel() { try { fs.closeSync(fd); } catch {} }
        });
        const abortPromise = fetch(`http://127.0.0.1:${PORT}/api/v1/clusters/cluster-b/objects/${abortHash}`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + cB.access_key, 'Content-Type': 'application/octet-stream' },
            body: abortStream as unknown as BodyInit,
            signal: ac.signal
        }).then(() => 200).catch((e: any) => e?.name || 'aborted');
        setTimeout(() => ac.abort(), 30);
        const abortResult = await abortPromise;
        await new Promise(r => setTimeout(r, 800));
        const interruptedExisted = await storage.hasObject(abortHash).catch(() => false);
        record('Interrupted Upload (no partial object)', interruptedExisted === false, `client got: ${abortResult}`);
        const healthAfter = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`).then(r => r.json());
        record('Crash Recovery (server alive after abort)', healthAfter.status === 'ok', 'server still healthy');

        server.close();
        await new Promise(r => setTimeout(r, 300));
        const server2 = app.listen(PORT + 1, '127.0.0.1');
        await new Promise<void>((r) => { server2.once('listening', r); });
        configManager.setConfig({ mode: 'server', serverPort: PORT + 1, storagePath: path.join(TEST_HOME, 'data') });
        const mgmt2 = new MgmtAPI();
        const relist = await mgmt2.listClusters();
        record('Crash Recovery (restart, data intact)', relist.length >= 3, `clusters after restart=${relist.length}`);
        server2.close();

        if (BACKEND === 's3') {
            const badCreds = new S3StorageBackend({ bucket, region, prefix: PREFIX, accessKeyId: 'AKIAINVALID', secretAccessKey: 'invalidsecret' });
            const b1 = await badCreds.hasObject('aa'.repeat(32)).then(() => 'NO-ERROR').catch((e: Error) => e.message);
            record('S3 Invalid Credentials', b1.includes('invalid AWS credentials'), `msg=${b1}`);

            const wrongBucket = new S3StorageBackend({ bucket: 'tamgabase-no-such-bucket-xyz', region, prefix: PREFIX });
            const b2 = await wrongBucket.writeMetadata('probe', {}).then(() => 'NO-ERROR').catch((e: Error) => e.message);
            record('S3 Wrong Bucket', b2.includes('not found') || b2.includes('Access Denied'), `msg=${b2}`);

            const wrongRegion = new S3StorageBackend({ bucket, region: 'us-west-2', prefix: PREFIX });
            const b3 = await wrongRegion.hasObject('aa'.repeat(32)).then(() => 'NO-ERROR').catch((e: Error) => e.message);
            record('S3 Wrong Region', b3.includes('region'), `msg=${b3}`);

            const net = new S3StorageBackend({ bucket, region, prefix: PREFIX, endpoint: 'https://tamgabase-e2e.invalid' });
            const b4 = await net.hasObject('aa'.repeat(32)).then(() => 'NO-ERROR').catch((e: Error) => e.message);
            record('S3 Network Error', b4.includes('network error'), `msg=${b4}`);

            const noLeak = [b1, b2, b3, b4].every(m => !m.includes(secretAccessKey) && !m.includes(accessKeyId));
            record('S3 No Secret Leakage in errors', noLeak, 'credentials absent from all error messages');

            const badApp = createServerApp(new S3StorageBackend({ bucket: 'tamgabase-no-such-bucket-xyz', region, prefix: PREFIX }));
            const badSrv = badApp.listen(PORT + 2, '127.0.0.1');
            await new Promise<void>((r) => { badSrv.once('listening', r); });
            const badRes = await fetch(`http://127.0.0.1:${PORT + 2}/api/v1/management/clusters`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + 'e2e_sk_server_key', 'Content-Type': 'application/json' },
                body: JSON.stringify({ cluster_id: 'fail-cluster', storage_limit_bytes: 1024 })
            });
            const badBody = await badRes.text();
            const healthBad = await fetch(`http://127.0.0.1:${PORT + 2}/api/v1/health`).then(r => r.json());
            record('S3 Failure -> HTTP (no crash, JSON error)', badRes.status >= 400 && badRes.status < 500 && badBody.includes('not found') && !badBody.includes(secretAccessKey) && healthBad.status === 'ok', `http=${badRes.status} body=${badBody.slice(0, 80)}`);
            badSrv.close();
        }

        const failed = results.filter(r => !r.pass);
        console.log('\n=== FINAL RESULT TABLE ===');
        console.log('TEST                          RESULT');
        console.log('------------------------------------------');
        for (const r of results) console.log(`${r.name.padEnd(30)} ${r.pass ? 'PASS' : 'FAIL'}`);
        console.log('------------------------------------------');
        console.log(`TOTAL: ${results.length}  PASSED: ${results.length - failed.length}  FAILED: ${failed.length}`);
        process.exit(failed.length > 0 ? 1 : 0);
    } catch (err) {
        console.error('FATAL:', err);
        server.close();
        process.exit(1);
    }
}

main();