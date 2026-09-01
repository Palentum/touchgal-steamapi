module.exports = {
  apps: [
    {
      name: "touchgal-steamapi",
      cwd: __dirname,
      script: "./server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      // 必须明显大于 server.js 的 SHUTDOWN_TIMEOUT_MS（默认 5000），
      // 给"强制断连 → server.close 回调 → 干净退出"留出余量。
      kill_timeout: 15000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
