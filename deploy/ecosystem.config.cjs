// PM2 ecosystem config — Find And Study OS (tek yetkili kaynak)
// Production güncellemeleri yalnızca preflight korumalı deploy/deploy.sh
// üzerinden yapılır. Config'i doğrudan `pm2 start` ile çalıştırmayın.
//
// NOT: Root dizinindeki ecosystem.config.cjs bu dosyayı referans alır.

"use strict";

const path = require("node:path");

const API_PROCESS_NAME = "fasos-apply-api";
const PORTAL_WORKER_PROCESS_NAME = "findandstudy-portal-worker";
const PORTAL_STATUS_WORKER_PROCESS_NAME = "findandstudy-portal-status-worker";
const PORTAL_LIFECYCLE_WORKER_PROCESS_NAME = "findandstudy-portal-lifecycle-worker";
const API_PORT = process.env.PORT || "5000";
const RELEASE_CWD = process.env.CURRENT_RELEASE_LINK
  ? path.resolve(process.env.CURRENT_RELEASE_LINK)
  : path.resolve(__dirname, "..");
const LOG_DIR = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.resolve(__dirname, "../logs");

module.exports = {
  apps: [
    {
      name: API_PROCESS_NAME,
      cwd: RELEASE_CWD,
      script: "./artifacts/api-server/dist/index.cjs",

      // Worker tekilleştirme tamamlanana kadar API de tek process çalışır.
      exec_mode: "fork",
      instances: 1,

      // PM2 measures total process RSS (not only the V8 heap). The API's
      // normal PDF/media/SSE workload can legitimately exceed 512 MB.
      max_memory_restart: "1G",

      // Dosya değişikliklerini izleme — deploy scripti yeniden başlatır
      watch: false,
      ignore_watch: ["node_modules", "logs", "dist", ".git"],

      // Ortam değişkenleri (pm2 start --env production ile etkinleşir)
      env_production: {
        NODE_ENV: "production",
        PORT: API_PORT,
      },

      // Log dosyaları
      out_file: path.join(LOG_DIR, "api-out.log"),
      error_file: path.join(LOG_DIR, "api-error.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      log_type: "json",

      // Graceful shutdown — wait_ready: true, process.send('ready') beklenir
      kill_timeout: 30000,
      wait_ready: true,
      listen_timeout: 10000,

      // Kilitlenme sonrası otomatik yeniden başlatma
      autorestart: true,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      restart_delay: 2000,
      min_uptime: "10s",

      // Hata izleri için kaynak haritaları
      node_args: "--enable-source-maps",
    },

    // -------------------------------------------------------------------------
    // Portal Automation Worker
    // -------------------------------------------------------------------------
    // Fork mode — tekil instance (SKIP LOCKED sayesinde birden fazla çalışmak
    // güvenli, ama bellek maliyeti yüksek; gerekirse instances artırılabilir).
    // tsx yorumlayıcısı sayesinde TypeScript kaynak dosyasını doğrudan çalıştırır
    // (workspace deps'in TS source export ettiği monorepo yapısıyla uyumlu).
    {
      name: PORTAL_WORKER_PROCESS_NAME,
      cwd: RELEASE_CWD,
      script: "./artifacts/portal-automation-worker/src/worker.ts",
      interpreter: path.join(
        RELEASE_CWD,
        "artifacts/portal-automation-worker/node_modules/.bin/tsx",
      ),

      exec_mode: "fork",
      instances: 1,

      // Chromium process'leri için 1 GB heap
      max_memory_restart: "1G",

      watch: false,

      env_production: {
        NODE_ENV: "production",
        // The dedicated worker does not own an HTTP listener. Explicitly
        // clear a shell-level PORT so topology checks cannot mistake it for
        // a second API process.
        PORT: "",
        // tsx heap + kaynak haritaları
        NODE_OPTIONS: "--max-old-space-size=512 --enable-source-maps",
        PLAYWRIGHT_HEADLESS: "true",
      },

      // Loglar — API server'dan ayrı dosyalar
      out_file: path.join(LOG_DIR, "portal-worker-out.log"),
      error_file: path.join(LOG_DIR, "portal-worker-error.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      // Graceful shutdown — Chromium'un temiz kapanması için
      // Allow the worker to finish one claimed portal transaction before PM2
      // force-kills it. Must exceed WORKER_SHUTDOWN_TIMEOUT_MS.
      kill_timeout: 130000,

      autorestart: true,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      restart_delay: 5000,
      min_uptime: "10s",
    },
    {
      name: PORTAL_STATUS_WORKER_PROCESS_NAME,
      cwd: RELEASE_CWD,
      script: "./artifacts/api-server/src/workers/portalStatusWorker.ts",
      interpreter: path.join(
        RELEASE_CWD,
        "artifacts/api-server/node_modules/.bin/tsx",
      ),
      exec_mode: "fork",
      instances: 1,
      max_memory_restart: "768M",
      watch: false,
      env_production: {
        NODE_ENV: "production",
        PORT: "",
        NODE_OPTIONS: "--max-old-space-size=512 --enable-source-maps",
      },
      out_file: path.join(LOG_DIR, "portal-status-worker-out.log"),
      error_file: path.join(LOG_DIR, "portal-status-worker-error.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      kill_timeout: 130000,
      autorestart: true,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      restart_delay: 5000,
      min_uptime: "10s",
    },
    {
      name: PORTAL_LIFECYCLE_WORKER_PROCESS_NAME,
      cwd: RELEASE_CWD,
      script: "./artifacts/api-server/src/workers/portalLifecycleWorker.ts",
      interpreter: path.join(
        RELEASE_CWD,
        "artifacts/api-server/node_modules/.bin/tsx",
      ),
      exec_mode: "fork",
      instances: 1,
      max_memory_restart: "512M",
      watch: false,
      env_production: {
        NODE_ENV: "production",
        PORT: "",
        NODE_OPTIONS: "--max-old-space-size=384 --enable-source-maps",
      },
      out_file: path.join(LOG_DIR, "portal-lifecycle-worker-out.log"),
      error_file: path.join(LOG_DIR, "portal-lifecycle-worker-error.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      kill_timeout: 30000,
      autorestart: true,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      restart_delay: 5000,
      min_uptime: "10s",
    },
  ],
  processNames: {
    api: API_PROCESS_NAME,
    portalWorker: PORTAL_WORKER_PROCESS_NAME,
    portalStatusWorker: PORTAL_STATUS_WORKER_PROCESS_NAME,
    portalLifecycleWorker: PORTAL_LIFECYCLE_WORKER_PROCESS_NAME,
  },
};
