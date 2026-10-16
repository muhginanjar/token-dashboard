// pm2 start ecosystem.config.cjs
// Config (API_KEY, PORT, …) is read from .env by server.js itself.
module.exports = {
  apps: [
    {
      name: 'dashboard-token',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,          // must stay 1: state and SSE clients live in memory
      exec_mode: 'fork',
      max_memory_restart: '150M',
      kill_timeout: 3000,    // give the debounced history save time to flush
      time: true,
    },
  ],
};
