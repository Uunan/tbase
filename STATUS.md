# TAMGABASE — SON DURUM / PROJE STATE DOSYASI

> Kapsamlı proje durum dosyası. Son güncelleme: v1.3.2, HTTPS reverse proxy + systemd + production HTTPS E2E (16/16) tamamlandı.
> Yeniden geliştirmeye başlarken bu dosyayı okuyun: mimari, test sonuçları, deploy, bilinen sorunlar ve yapılacakların tümü aşağıda.

---

## 1. ÖZET

TamgaBase = Git benzeri, kendi barındırılan (self-hosted), içerik adresli (content-addressable / CAS) veri senkronizasyon ve depolama CLI sistemi. Node.js + TypeScript, Express, Commander.

| Alan | Değer |
|---|---|
| npm paketi | `@tamgallc/tamgabase` — **v1.3.2 (latest, yayında)** |
| GitHub repo | `Uunan/tbase` — **main @ commit `9db16115`** (v1.3.0; v1.3.1/1.3.2 npm'de, GitHub push'u bekliyor) |
| Sürüm geçmişi | v1.0.x (temel push/pull/heartbeat) → v1.2.0 (multi-tenant cluster, auth ayrımı, quota) → v1.3.0 (**S3 StorageBackend**) → v1.3.1 (quota TOCTOU fix: sync check+reserve) → v1.3.2 (**quota kümülatif sayım fix: pushedBytes, doğru [0,402,402] semantiği**) |
| Dil / build | TypeScript strict, `tsc`, Node 22+ |

---

## 2. MİMARİ

```
                    ┌──────────────────────┐
                    │    StorageBackend    │  (src/storage/interface.ts)
                    └──────────┬───────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                    ▼                     ▼
             LocalStorageBackend    S3StorageBackend
                    │                     │
                    ▼                     ▼
              Local Disk             AWS S3
```

- `StorageBackend` kontratı: `writeObject(hash, content)`, `readObject`, `readObjectStream`, `hasObject`, `writeMetadata(key, data)`, `readMetadata(key)`.
- Her iki backend de aynı mantıksal layout'u kullanır (CAS + metadata), aynı kurallara uyar (CAS, snapshot, cluster, auth, quota, delta sync, concurrency, data integrity).
- `createServerApp(storage: StorageBackend)` — sunucu mantığı backend'e bağımlı değil; yeni backend eklemek sunucu koduna dokunmaz.

### 2.1 Obje / Metadata Layout (iki backend de aynı)
| İçerik | Yol / S3 Key |
|---|---|
| CAS objeleri | `<prefix>/objects/<ilk_2_hex>/<kalan_62_hex>` |
| Cluster config | `<prefix>/metadata/cluster_config_<clusterId>.json` |
| Token index | `<prefix>/metadata/cluster_token_index.json` |
| Snapshot'lar | `<prefix>/metadata/cluster_<clusterId>_<snapshotId>.json` |
| Latest işaretçisi | `<prefix>/metadata/cluster_<clusterId>_latest.json` |

- Dedup **global**: aynı içerik nereden yüklenirse yüklensin tek fiziksel obje.
- Hash doğrulama: sunucu yüklenen her body'nin SHA-256'sını yeniden hesaplar; uyuşmazsa `400 Hash Mismatch`.
- Atomicity: Local = `.tmp` + `rename()`; S3 = tek parça atomik `PutObject` (kesilen upload yarım obje bırakmaz) + `SlowDown` (503) backoff ile 3 deneme.

### 2.2 Kimlik Doğrulama & İzolasyon
- **Server key `tb_sk_...`** → yalnızca Management API (cluster CRUD, key rotation). Yalnızca sunucu makinesinde CLI ile (`MgmtAPI` localhost'a bağlanır).
- **Cluster key `tb_cl_...`** → yalnızca kendi cluster'ının Data API'si (push/pull, snapshot).
- Middleware (`src/server/auth.ts`): token → cluster eşleşmesi yapılır, URL'deki `clusterId` ile karşılaştırılır; uyuşmazlık → **403 Forbidden** + `Isolation Breach Attempt` logu.

### 2.3 Quota Modeli
- **Logical quota** = cluster'ın `latest` snapshot'ındaki dosya boyutları toplamı (CAS nedeniyle fizikselden farklı olabilir).
- **Kümülatif + in-flight koruma (v1.3.2):** `checkAndReserveQuota` şu formülü senkron/atomik uygular: `usedBytes (snapshot) + pushedBytes (snapshot'tan beri başarıyla yazılan) + inFlightBytes (devam eden yazımlar) + yeni boyut ≤ storageLimitBytes`, aşarsa **402**.
  - `pushedBytes` yalnızca **başarılı** write sonrası release'de artar; `inFlightBytes` reserve'de artar, her release'de azalır; snapshot (`recalculateQuotaFromSnapshot`) ikisini de sıfırlar.
  - v1.3.1'deki TOCTOU fix'i (S3 read'den önce senkron check) + v1.3.2'deki kümülatif sayım, upload'lar serileşse bile (paralel olmasa da) kotanın aşılamamasını garanti eder: `[0,402,402]` deterministik.
- Dikkat: kota hesabı snapshot'ta sıfırlandığı için, snapshot arası yüklemeler `pushedBytes` ile sayılır; push sonrası snapshot oluşturulmazsa `pushedBytes` kalıcı sayılır (kasıtlı, güvenli taraf).

### 2.4 Concurrency
- Client push/pull: `p-limit` ile `CONCURRENCY_LIMIT = 5` (tüm dosyalar üzerinde `Promise.all` YOK). Test: 1000 dosyalık push'ta `maxActive=5` doğrulandı.

---

## 3. DOSYA HARİTASI (src/)

| Dosya | Görev |
|---|---|
| `src/index.ts` | CLI girişi (`runCLI`) |
| `src/cli/index.ts` | Tüm komutlar: `init, status, server, push, pull, heartbeat, cluster create/list/delete, key show/rotate, storage local/s3` (v1.3.0) |
| `src/cli/ui.ts` | Banner/ASCII sanatı, interaktif sorular |
| `src/client/api.ts` | `ClientAPI` (data API) + `MgmtAPI` (management API). Hatalara HTTP `status` ekler (400/402/403 ayrımı) |
| `src/client/sync.ts` | `SyncEngine` — push/pull, tarama, p-limit=5 |
| `src/core/crypto.ts` | SHA-256 yardımcıları |
| `src/core/keys.ts` | `tb_sk_...` üretim/okuma (.server_key, 600 izin) |
| `src/server/app.ts` | Express uygulaması: Management API + Data API rotaları (`StorageBackend` tipiyle) |
| `src/server/auth.ts` | `requireManagementAuth` / `requireClusterAuth` + izolasyon 403'ü |
| `src/server/clusterManager.ts` | Cluster CRUD, key rotation, token index, quota in-flight sayacı, snapshot'tan quota hesabı |
| `src/server/index.ts` | `startServer()` — config'e göre Local veya S3 backend seçimi |
| `src/storage/interface.ts` | **StorageBackend kontratı** (değişmedi, korunuyor) |
| `src/storage/local.ts` | LocalStorageBackend (davranışı değişmedi) |
| `src/storage/s3.ts` | **S3StorageBackend (v1.3.0)** — env'den creds, atomic PUT, SlowDown retry, hata maskeleme |
| `src/utils/config.ts` | `config.json` yönetimi (`~/.tamgabase`). Alanlar: mode, serverAddress/Port, storagePath, workspacePath, keyPolicy, clusterId, **storageBackend, s3Bucket, s3Region, s3Prefix** |
| `src/utils/logger.ts` | Logger (warn/info/error) |
| `src/e2e/run.ts` | **E2E test suite** — gerçek HTTP + gerçek server + gerçek S3; `--backend s3\|local --port N` |
| `src/e2e/external.ts` | **HTTPS/uzak sunucu E2E suite** (v1.3.1) — `node dist/e2e/external.js --external <url> --mgmt-key <tb_sk_>`; benzersiz `e2e-<ts>-a/b/c` cluster'ları, sonunda cleanup |

---

## 4. TEST SONUÇLARI (GERÇEK S3 + GERÇEK LOCAL, 2026-08)

### S3 Suite — **28/28 PASS** (`--backend s3`)
Build, Server Boot, Health, S3 Connection, Multi Cluster (a/b/c), Path Traversal (6/6), Cluster Isolation (3/3 → 403), S3 Push, Snapshot yazımı, CAS Dedup (5 dosya→1 obje), Delta Sync (1/10 değişince 1 obje), Pull (hash/klasör birebir), Data Integrity (11 dosya round-trip), Hash Validation (400), Quota (paralel `[0,402,402]` + in-flight koruma), Same Object Concurrency (100 paralel → 1 obje, içerik doğru), Key Rotation (eski 403 / yeni 200), Concurrent Upload (maxActive=5), 1000 File Upload (101 benzersiz obje), Interrupted Upload (yarım obje yok), Crash Recovery (restart'ta veri duruyor), S3 Invalid Credentials / Wrong Bucket / Wrong Region / Network Error (hepsi mapped, sunucu ayakta), Secret Leakage (hata mesajlarında creds yok), S3 Failure→HTTP (500/400 JSON, çökme yok).

### Local Regression Suite — **20/20 PASS** (`--backend local`)
Aynı core testler local disk üzerinde; 1000 dosya **1.15s** (S3'te 46.7s).
Quota beklentisi v1.3.2 itibarıyla güncellendi: `parallel=[0/402 karışık] extra=402 final3MB=402` (kümülatif semantik).

### Production HTTPS E2E — **16/16 PASS** (`dist/e2e/external.js` vs `https://tbase.tamga.run`)
Health (1.3.0), Mgmt create/list/unique-keys, Push, Isolation 3/3 (403), Pull, Data Integrity, Hash 400, **Quota `[402,0,402]`**, Same Object 100/100, Key rotation (old 403/new 200), Interrupted Upload, 1000 File Push (3.8s), Mgmt delete. v1.3.2 fix'i sonrası tamamı geçti (v1.3.1'de quota uzak sunucuda `[0,0,0]` kalıyordu → kümülatif sayım eksikti).

**Ölçüm notları:** 1000 dosya push: S3 46.7s / local 1.15s / HTTPS prod ~3.8s, RSS Δ ~+11MB, maxActive=5. Test sonunda S3 `tamgabase/` prefix'inde yalnızca sistem dosyası `cluster_token_index.json` kaldı (170 test objesi + silinmiş cluster metadata'ları temizlendi, 2026-08-19).

---

## 5. AWS / S3 KONFİGÜRASYONU (PRODUCTION)

| Alan | Değer |
|---|---|
| Bucket | `tamgabase-production-storage` |
| Region | `eu-north-1` |
| Prefix | `tamgabase` (sunucu config.json'da) |
| Erişim | CSV: `tamgabase-s3_accessKeys.csv` (repo kökünde, `*.csv` .gitignore'da) |
| Access Key ID | `AKIAVZHCK*******` (maske) |
| Secret Access Key | `********` (asla dosyaya/loga yazılmadı, yalnızca env) |

### 5.1 Güvenlik Modeli
- Credentials **yalnızca environment**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET`, opsiyonel `TAMGABASE_S3_PREFIX`. **Config.json'a, source'a, snapshot'a, log'a, API response'una asla yazılmaz.**
- Sunucu tarafında `/etc/tamgabase.env` (600 izin) veya shell export ile sağlanır.
- IAM minimal (testte doğrulandı: `ListBuckets` reddediliyor, S3 ops çalışıyor):
  `s3:GetObject, s3:PutObject, s3:HeadObject, s3:ListBucket` yalnızca `tamgabase-production-storage` arn'ına.
- Backend başka AWS kaynağına erişmez; bucket public değildir.
- Tüm AWS hataları genel `S3: ...` mesajlarına çevrilir (raw hata gövdesi API'ye sızmaz, secret sızmaz).

---

## 6. PRODUCTION SUNUCU DURUMU

| Alan | Değer |
|---|---|
| Sunucu | AWS Ubuntu (13.60.179.245) |
| Domain | `tbase.tamga.run` (HTTPS, 80→301 redirect) |
| Port | 7420 (app, localhost'a bağlı; dışarı yalnızca 443/80) |
| Kurulu | `@tamgallc/tamgabase` v1.3.2 (global npm) |
| Backend | S3 (`tamgabase-production-storage` eu-north-1, prefix `tamgabase`) |
| Key Policy | `show_once` |
| Çalışma | **systemd servisi aktif** (`tamgabase.service`, Restart=always, RestartSec=5, User=root) |
| TLS | **aaPanel (BT-Panel) nginx reverse proxy** — Let's Encrypt sertifikası (17 Kas 2026'ya kadar geçerli) |
| Management key | `tb_sk_d32f...` (tam değer güvenli yerde; bu dosyaya yazılmadı) |

### 6.1 HTTPS Kurulumu (aaPanel nginx)
- `/www/server/panel/vhost/nginx/extension/tbase.tamga.run/api-proxy.conf` — `location /api/ { proxy_pass http://127.0.0.1:7420; client_max_body_size 0; proxy_request_buffering off; proxy_buffering off; ... }` (aaPanel site düzenlemeleri extension dizinini korur)
- `/www/server/panel/vhost/nginx/tbase-redirect.conf` — port 80 server block: `tbase.tamga.run` → **301** `https://$host$request_uri` (nginx.conf yalnızca `/www/server/panel/vhost/nginx/*.conf` include eder; dosya alfabetik önce geldiği için kazanır)
- `serverProtocol` config alanı (`src/utils/config.ts` + `src/client/api.ts`) → client CLI HTTPS base URL kullanır (`--external https://...` test akışı da aynı mekanizmayı kullanır)
- Doğrulanan: `https://tbase.tamga.run/api/v1/health` OK, `http://...` → 301, Management + Data API HTTPS üzerinden tam çalışıyor
- **Kural:** `tb_sk_*` asla HTTP üzerinden gönderilmez; TLS yalnızca proxy katmanında (kodda TLS yok)

### 6.2 Doğrulanan Canlı Testler (uzaktan, HTTPS)
- `GET /api/v1/health` → `{"status":"ok","version":"1.3.0"}` ✅ (versiyon sabit yazılı, kozmetik — §8)
- `POST /api/v1/management/clusters` + `DELETE` → create/delete ✅
- Production HTTPS E2E **16/16** (bkz. §4) ✅
- S3 temizlik: test objeleri + silinmiş cluster metadata'ları silindi; yalnızca `cluster_token_index.json` kaldı ✅

---

## 7. OPERASYON KOMUTLARI

```bash
# Sunucu makinesinde
tamgabase init                 # server modu (tb_sk_ üretir, 1 kez gösterir)
tamgabase storage local        # veya
tamgabase storage s3           # bucket/region/prefix sorar; creds env'den
tamgabase server               # başlat (creds için önce: set -a; source ~/.tamgabase.env; set +a)
tamgabase cluster create proje-x --quota 50     # 50 GB cluster
tamgabase cluster list
tamgabase cluster delete proje-x
tamgabase key show / key rotate

# Client makinesinde
tamgabase init                 # client modu → sunucu adresi + cluster key ister
tamgabase push -m "mesaj"
tamgabase pull
tamgabase heartbeat
```

### 7.1 Kalıcı (systemd) servis — **kuruldu, aktif** (sunucu: `/etc/systemd/system/tamgabase.service`)
```ini
[Unit]
Description=TamgaBase Server
After=network.target

[Service]
Type=simple
User=root
EnvironmentFile=/root/.tamgabase.env
ExecStart=/usr/bin/tamgabase server
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now tamgabase
# güncelleme: sudo npm i -g @tamgallc/tamgabase && sudo systemctl restart tamgabase
```

---

## 8. BİLİNEN SORUNLAR / İYİLEŞTİRMELER

### LOW
1. **Windows local backend:** Aynı içeriğe 100 paralel doğrudan PUT → bazı `rename` EEXIST (60/100). CAS bütünlüğü korunuyor (1 obje, içerik doğru). Normal kullanımda p-limit=5 olduğu için tetiklenmez. v1.2'den beri mevcut, regresyon değil.
2. **S3 SlowDown:** 100'lük burst PUT'ta S3 503 dönebilir → backend backoff ile 3 deneme yapıyor; aşırı burst'te tek 500 olasılığı kalır (sunucu çökmez).
3. **npm paketinde `dist/e2e`:** `.npmignore`'daki hariç tutma, `files` whitelist'i nedeniyle etkisiz; `dist/e2e/run.js` pakete giriyor (zararsız, secret içermez). İstenirse `files` listesi daraltılmalı.
4. **Health versiyonu sabit:** `src/server/app.ts:18` versiyonu paket sürümünden bağımsız `'1.3.0'` yazıyor (sunucu 1.3.2 de olsa). Kozmetik; paket sürümünü okuyacak şekilde düzeltilmeli.
5. **aaPanel nginx:** reload'da `conflicting server name on 0.0.0.0:80` uyarısı çıkar (redirect dosyası vhost'ta önce geldiği için davranış doğru); aaPanel site edit'i `tbase-redirect.conf`'u ezebilir — değişiklik sonrası kontrol edilmeli.

### AÇIK / YAPILACAKLAR (pending)
1. **Uzaktan cluster yönetimi (`--host`):** Şu an CLI yalnızca sunucu makinesinde çalışıyor (`MgmtAPI` localhost + server-mode guard). Uzaktan management için curl örneği: `curl -X POST https://tbase.tamga.run/api/v1/management/clusters -H "Authorization: Bearer <tb_sk_>" -H "Content-Type: application/json" -d '{"cluster_id":"proje-x","storage_limit_bytes":53687091200}'` (Docker/panel entegrasyonu bu API ile yapılır). `--host` CLI özelliği hâlâ öneriliyor.
2. **GitHub push:** v1.3.1/1.3.2 değişiklikleri (quota fix, external.ts, serverProtocol, HTTPS kurulum dokümanı) GitHub `main`'e işlenmedi — `deploy.js` (git-data API) veya git ile push edilmeli.
3. **Cluster başına S3 prefix izolasyonu:** Kod doğrulaması (2026-08-19): objeler TEK ortak `tamgabase/objects/` prefix'inde (src/storage/s3.ts:62-74), cluster izolasyonu yalnızca API katmanında (auth.ts token→cluster + 403). Yani S3/IAM seviyesinde müşteri ayrımı yok; cluster silme objeleri silmez. Mevcut ürün kararı: kabul (yalnızca API izolasyonu) — müşteri bazında fiziksel ayırım istenirse per-cluster prefix + CAS'ın global paylaşımını bırakmak gerekir (üzerinde çalışılmalı).
4. **TAMGABASE_HOME env desteği:** Daha önce eklenmişti, sonra geri alındı (testler monkeypatch ile hallediyor). Çoklu instance istenirse tekrar eklenebilir.
5. **docs'a sequence diyagramları:** v1.2 sırasında sohbette verildi, docs'a tam işlenmedi.

---

## 9. YAYINLAMA DURUMU

- **npm:** `@tamgallc/tamgabase@1.3.2` latest ✅ (v1.3.1: quota TOCTOU fix; v1.3.2: kümülatif pushedBytes semantiği)
  - Yayın yöntemi: repo kökünde `.npmrc` (`//registry.npmjs.org/:_authToken=...`, gitignored değil — **dikkat: commit'e girmemeli**; gerekirse silinip yeniden oluşturulur) → `npm publish --access public`.
- **GitHub:** `Uunan/tbase` main, commit `9db16115` ✅ (v1.3.0) — v1.3.1/1.3.2 push'u bekliyor (bkz. §8 pending #2).
  - Token'lar asla commit'e girmedi (secret scanning koruması); CSV asla push edilmedi.
- **Credential'ların yeri:** CSV dosyası repo kökünde (gitignored); sunucuda `/root/.tamgabase.env` (600); management key sunucu `/root/.tamgabase/.server_key`.

---

## 10. YENİDEN GELİŞTİRMEYE BAŞLAMA (QUICKSTART)

```bash
# 1) Bağımlılıklar
npm install

# 2) Build (strict TS)
npm run build

# 3) Local regression testi (kod gerektirmez)
node dist/e2e/run.js --backend local --port 7435

# 4) S3 E2E (AWS env gerekir: CSV'yi env'e yükle)
#   $env:AWS_ACCESS_KEY_ID=... $env:AWS_SECRET_ACCESS_KEY=...
#   $env:AWS_REGION=eu-north-1 $env:AWS_S3_BUCKET=tamgabase-production-storage
node dist/e2e/run.js --backend s3 --port 7431

# 5) Production HTTPS E2E (canlı sunucuya karşı; key'i güvenli yerden al)
node dist/e2e/external.js --external https://tbase.tamga.run --mgmt-key <tb_sk_>
```

**Unutma:** `tamgabase-s3_accessKeys.csv` asla GitHub'a/npm'e girmemeli (`.gitignore` + `.npmignore` + publish dosya listesinde yok). Testler her zaman izole `e2e-test-*` prefix'inde çalışır ve sonunda temizlenir.

---

## 11. KREDİBİL/ÖNEMLİ NOTLAR

- `tamgabase init` client modunda cluster key'i `~/.tamgabase/client_keys.json`'a **düz metin** yazar (dokümante edilmiş basitleştirme; üretimde keychain önerilir).
- Management key (`tb_sk_*`) yalnızca oluşturma/rotate sırasında 1 kez gösterilir (`show_once` policy). Kaybetme.
- Cluster silme fiziksel objeleri silmez (global CAS paylaşımı) — yalnızca config + token index güncellenir.
- Sunucu `0.0.0.0` dinler; firewall: `sudo ufw allow 7420/tcp`.