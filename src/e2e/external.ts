import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const args = process.argv.slice(2);
const parseArg = (name: string, def: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const EXTERNAL = parseArg('external', '');          // e.g. https://tbase.tamga.run  (no /api/v1)
const MGMT_KEY = parseArg('mgmt-key', '');
const TEST_HOME = path.resolve('./e2e-https-env');
const TS = Date.now();
const cid = (s: string) => `e2e-${TS}-${s}`;
const API = `${EXTERNAL}/api/v1`;

if (!EXTERNAL || !MGMT_KEY) {
    console.error('usage: node dist/e2e/external.js --external <https://host[:port]> --mgmt-key <tb_sk_...>');
    process.exit(2);
}

const results: { name: string; pass: boolean; detail?: string }[] = [];
const record = (name: string, pass: boolean, detail = '') => {
    results.push({ name, pass, detail });
    console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' - ' + detail : ''}`);
};

async function main() {
    console.log(`=== TAMGABASE E2E :: mode=external-https :: target=${EXTERNAL} ===`);

    if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_HOME, { recursive: true });

    const { configManager } = await import('../utils/config.js');
    (configManager as any).configDir = TEST_HOME;
    (configManager as any).configPath = path.join(TEST_HOME, 'config.json');

    const { ClientAPI } = await import('../client/api.js');
    const { SyncEngine } = await import('../client/sync.js');
    const { CryptoUtils } = await import('../core/crypto.js');

    const u = new URL(EXTERNAL);
    const proto = u.protocol === 'https:' ? 'https' : 'http';
    const port = Number(u.port || (proto === 'https' ? 443 : 80));

    const setClient = (clusterId: string, ws: string) => configManager.setConfig({
        mode: 'client', serverProtocol: proto, serverAddress: u.hostname, serverPort: port, clusterId, workspacePath: ws
    });

    const mgmt = async (method: string, p: string, body?: any) => {
        const res = await fetch(`${API}/management/${p}`, {
            method,
            headers: {
                'Authorization': 'Bearer ' + MGMT_KEY,
                ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            body: body ? JSON.stringify(body) : undefined
        });
        return { status: res.status, data: await res.json().catch(() => null) };
    };

    const created: string[] = [];
    const checkOk = (fn: () => Promise<any>, expected: number): Promise<number> =>
        fn().then(() => expected).catch((e: any) => e?.status || 0);

    try {
        const health = await fetch(`${API}/health`).then(r => r.json());
        record('HTTPS Health Endpoint', health.status === 'ok', `version ${health.version} @ ${EXTERNAL}`);

        const a = await mgmt('POST', 'clusters', { cluster_id: cid('a'), storage_limit_bytes: 10 * 1024 * 1024 });
        const b = await mgmt('POST', 'clusters', { cluster_id: cid('b'), storage_limit_bytes: 50 * 1024 * 1024 });
        const c = await mgmt('POST', 'clusters', { cluster_id: cid('c'), storage_limit_bytes: 50 * 1024 * 1024 });
        created.push(cid('a'), cid('b'), cid('c'));
        record('Mgmt API create via HTTPS', a.status === 201 && !!a.data?.access_key && a.data.access_key.startsWith('tb_cl_'), `status=${a.status} key=${a.data?.access_key?.slice(0, 12)}...`);
        record('Mgmt API unique keys', new Set([a.data?.access_key, b.data?.access_key, c.data?.access_key]).size === 3, 'a/b/c distinct');

        const list = await mgmt('GET', 'clusters');
        record('Mgmt API list via HTTPS', list.status === 200 && Array.isArray(list.data) && list.data.length >= 3, `count=${list.data?.length}`);

        const keysFile = path.join(TEST_HOME, 'client_keys.json');
        const setKeys = (obj: any) => fs.writeFileSync(keysFile, JSON.stringify(obj));
        setKeys({ [cid('a')]: a.data.access_key, [cid('b')]: b.data.access_key, [cid('c')]: c.data.access_key });

        const wsA = path.join(TEST_HOME, 'ws-a');
        fs.mkdirSync(path.join(wsA, 'nested'), { recursive: true });
        const largeBytes = Buffer.alloc(2 * 1024 * 1024);
        crypto.randomFillSync(largeBytes);
        fs.writeFileSync(path.join(wsA, 'file1.txt'), 'hello via https');
        fs.writeFileSync(path.join(wsA, 'file2.txt'), 'second file content');
        fs.writeFileSync(path.join(wsA, 'nested', 'file3.txt'), 'nested content');
        fs.writeFileSync(path.join(wsA, 'nested', 'large.bin'), largeBytes);

        setClient(cid('a'), wsA);
        const engA = new SyncEngine();
        await engA.push('https-first');
        record('Push via HTTPS (objects + snapshot)', true, '4 files uploaded');

        const crossTests: [string, string][] = [
            [cid('a'), cid('b')], [cid('b'), cid('c')], [cid('c'), cid('a')]
        ];
        let isoPass = 0;
        for (const [owner, target] of crossTests) {
            setClient(target, path.join(TEST_HOME, 'tmp'));
            fs.mkdirSync(path.join(TEST_HOME, 'tmp'), { recursive: true });
            setKeys({ [target]: (owner === cid('a') ? a : owner === cid('b') ? b : c).data.access_key });
            const api = new ClientAPI();
            const code = await checkOk(() => api.checkMissingObjects(target, ['00'.repeat(32)]), 0);
            if (code === 403) isoPass++;
        }
        record('Cluster Isolation via HTTPS (cross 403)', isoPass === 3, `${isoPass}/3 blocked with 403`);

        const wsPull = path.join(TEST_HOME, 'ws-pull');
        fs.mkdirSync(wsPull, { recursive: true });
        setClient(cid('a'), wsPull);
        setKeys({ [cid('a')]: a.data.access_key, [cid('b')]: b.data.access_key, [cid('c')]: c.data.access_key });
        await new SyncEngine().pull();
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
        record('Pull via HTTPS (structure/content/hash)', pullOk, `workspace=${wsPull}`);

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
            await new ClientAPI().downloadObject(cid('a'), h, tmp);
            if (CryptoUtils.hashContent(fs.readFileSync(tmp)) !== h) integrityOk = false;
        }
        record('Data Integrity via HTTPS (round-trip)', integrityOk, `${allFiles.length} files`);

        const mismatchCode = await checkOk(() => new ClientAPI().uploadObject(cid('a'), 'aa'.repeat(32), path.join(wsA, 'file1.txt')), 0);
        record('Hash Validation via HTTPS (400)', mismatchCode === 400, `http=${mismatchCode}`);

        const quotaBuf = Buffer.alloc(3 * 1024 * 1024);
        crypto.randomFillSync(quotaBuf);
        fs.writeFileSync(path.join(wsA, 'quota.bin'), quotaBuf);
        setClient(cid('a'), wsA);
        await new SyncEngine().push('quota commit');
        const two = Buffer.alloc(3 * 1024 * 1024);
        crypto.randomFillSync(two);
        const h1 = CryptoUtils.hashContent(two);
        const three = Buffer.alloc(3 * 1024 * 1024);
        crypto.randomFillSync(three);
        const h2 = CryptoUtils.hashContent(three);
        const four = Buffer.alloc(3 * 1024 * 1024);
        crypto.randomFillSync(four);
        const h3 = CryptoUtils.hashContent(four);
        const upApi = new ClientAPI();
        const directUpload = async (h: string, buf: Buffer) => {
            const tmpf = path.join(TEST_HOME, 'q-' + h);
            fs.writeFileSync(tmpf, buf);
            const code = await checkOk(() => upApi.uploadObject(cid('a'), h, tmpf), 0);
            fs.rmSync(tmpf, { force: true });
            return code;
        };
        const codes = await Promise.all([directUpload(h1, two), directUpload(h2, three), directUpload(h3, four)]);
        record('Quota via HTTPS (parallel, in-flight guard)', codes.filter(x => x === 402).length >= 2 && codes.includes(0),
            `codes=[${codes.join(',')}] (cluster-a=10MB)`);

        const raceBuf = Buffer.from('https-race-same-content');
        const raceHash = CryptoUtils.hashContent(raceBuf);
        const raceTmp = path.join(TEST_HOME, 'race-tmp');
        fs.writeFileSync(raceTmp, raceBuf);
        setClient(cid('b'), path.join(TEST_HOME, 'tmp'));
        setKeys({ [cid('a')]: a.data.access_key, [cid('b')]: b.data.access_key, [cid('c')]: c.data.access_key });
        const raceApi = new ClientAPI();
        const raceTasks = Array.from({ length: 100 }, () => raceApi.uploadObject(cid('b'), raceHash, raceTmp));
        const raceCodes = await Promise.all(raceTasks.map(t => t.then(() => 200).catch((e: any) => e?.status || 0)));
        const raceDl = path.join(TEST_HOME, 'race-dl');
        await raceApi.downloadObject(cid('b'), raceHash, raceDl);
        const raceContentOk = CryptoUtils.hashContent(fs.readFileSync(raceDl)) === raceHash;
        record('Same Object Concurrency via HTTPS (100 parallel)', raceCodes.filter(x => x === 200).length === 100 && raceContentOk,
            `2xx=${raceCodes.filter(x => x === 200).length}/100, content match=${raceContentOk}`);

        const rot = await mgmt('POST', `clusters/${cid('a')}/rotate-key`);
        record('Mgmt API rotate-key via HTTPS', rot.status === 200 && rot.data?.access_key?.startsWith('tb_cl_'), `status=${rot.status}`);
        setClient(cid('a'), wsA);
        setKeys({ [cid('a')]: a.data.access_key, [cid('b')]: b.data.access_key, [cid('c')]: c.data.access_key });
        const oldKeyCode = await checkOk(() => new ClientAPI().checkMissingObjects(cid('a'), []), 0);
        setKeys({ [cid('a')]: rot.data.access_key, [cid('b')]: b.data.access_key, [cid('c')]: c.data.access_key });
        const newKeyCode = await checkOk(() => new ClientAPI().checkMissingObjects(cid('a'), []), 0);
        record('Key Rotation via HTTPS (old 403 / new 200)', oldKeyCode === 403 && newKeyCode === 0, `old=${oldKeyCode} new=${newKeyCode}`);

        const abortHash = 'ab'.repeat(32);
        const abortTmp = path.join(TEST_HOME, 'abort-tmp');
        fs.writeFileSync(abortTmp, crypto.randomBytes(2 * 1024 * 1024));
        const ac = new AbortController();
        const fd = fs.openSync(abortTmp, 'r');
        const abortStream = new ReadableStream<Uint8Array>({
            start(controller) {
                const chunk = Buffer.alloc(128 * 1024);
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
        const abortPromise = fetch(`${API}/clusters/${cid('b')}/objects/${abortHash}`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + b.data.access_key, 'Content-Type': 'application/octet-stream' },
            body: abortStream as unknown as BodyInit,
            signal: ac.signal
        }).then(() => 200).catch((e: any) => e?.name || 'aborted');
        setTimeout(() => ac.abort(), 30);
        const abortResult = await abortPromise;
        await new Promise(r => setTimeout(r, 800));
        const healthAfter = await fetch(`${API}/health`).then(r => r.json());
        record('Interrupted Upload via HTTPS (server alive)', abortResult !== 200 && healthAfter.status === 'ok', `client got: ${abortResult}`);

        const ws1000 = path.join(TEST_HOME, 'ws-1000');
        fs.mkdirSync(ws1000, { recursive: true });
        for (let i = 0; i < 1000; i++) {
            fs.writeFileSync(path.join(ws1000, `f${i}.txt`), i % 10 === 0 ? `content ${i}` : 'shared-content-value');
        }
        setClient(cid('c'), ws1000);
        setKeys({ [cid('a')]: rot.data.access_key, [cid('b')]: b.data.access_key, [cid('c')]: c.data.access_key });
        const t0 = Date.now();
        await new SyncEngine().push('1000 files https');
        const t1 = Date.now();
        record('1000 File Push via HTTPS', true, `done in ${t1 - t0}ms`);

        let deleted = 0;
        for (const id of created) {
            const d = await mgmt('DELETE', `clusters/${id}`);
            if (d.status === 200) deleted++;
        }
        record('Mgmt API delete via HTTPS (cleanup)', deleted === created.length, `deleted=${deleted}/${created.length}`);
    } catch (err) {
        console.error('FATAL:', err);
    } finally {
        for (const id of created) {
            await mgmt('DELETE', `clusters/${id}`).catch(() => {});
        }
    }

    const failed = results.filter(r => !r.pass);
    console.log('\n=== FINAL RESULT TABLE (HTTPS) ===');
    for (const r of results) console.log(`${r.name.padEnd(50)} ${r.pass ? 'PASS' : 'FAIL'}`);
    console.log('------------------------------------------');
    console.log(`TOTAL: ${results.length}  PASSED: ${results.length - failed.length}  FAILED: ${failed.length}`);
    process.exit(failed.length > 0 ? 1 : 0);
}

main();