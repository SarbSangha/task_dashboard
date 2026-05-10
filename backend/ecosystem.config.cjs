module.exports = {
  apps: [
    {
      name: 'backend',
      cwd: __dirname,
      script: 'venv/bin/uvicorn',
      args: 'main:app --host 0.0.0.0 --port 8000',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      time: true,
      merge_logs: true,
      env: {
        PYTHONUNBUFFERED: '1',
      },
    },
  ],
};
