module.exports = {
  apps: [
    {
      name: 'backend',
      cwd: __dirname,
      script: 'venv/bin/python3',
      args: [
        '-m',
        'uvicorn',
        'main:app',
        '--host',
        '0.0.0.0',
        '--port',
        '8000',
        '--workers',
        process.env.WEB_CONCURRENCY || '2',
      ],
      interpreter: 'none',
      autorestart: true,
      watch: false,
      time: true,
      merge_logs: true,
      env: {
        PYTHONUNBUFFERED: '1',
        // Per worker. Postgres allows 100 connections in total (3 reserved):
        // 2 workers x 25 = 50 leaves room for local dev backends on the SSH
        // tunnel, scripts and psql. 20 + 20 (80) plus one dev backend (30)
        // went over the limit.
        DB_POOL_SIZE: '15',
        DB_MAX_OVERFLOW: '10',
        DB_POOL_TIMEOUT: '5',
        DB_POOL_RECYCLE: '1800',
        SLOW_REQUEST_LOG_MS: '3000',
        LOGIN_RATE_LIMIT_ATTEMPTS: '5',
        LOGIN_RATE_LIMIT_WINDOW_SECONDS: '60',
        AUTH_RESPONSE_CACHE_TTL_SECONDS: '10',
        AUTH_CLEANUP_INTERVAL_SECONDS: '3600',
        NOTIFICATION_QUEUE_MAX_SIZE: '1000',
        NOTIFICATION_QUEUE_WORKERS: '2',
        WEB_CONCURRENCY: process.env.WEB_CONCURRENCY || '2',
      },
    },
  ],
};
