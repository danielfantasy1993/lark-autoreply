module.exports = {
  apps: [
    {
      name: "lark-autoreply",
      script: "npm",
      args: "run autoreply",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};