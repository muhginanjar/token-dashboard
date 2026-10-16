# Token Usage Dashboard

A real-time dashboard for monitoring the usage of **a single API token**: OpenRouter, or any OpenAI-compatible provider through the built-in proxy.

- **Lightweight**: no dependencies, no build step. Just `server.js` and one HTML file.
- **Real-time**: updates are pushed to the browser over Server-Sent Events. The provider is only polled while a dashboard tab is open.
- **Safe**: the token stays on the server and is never sent to the browser.

## Running

```bash
cp .env.example .env   # set API_KEY
npm start              # → http://127.0.0.1:8787
```

Requires Node.js ≥ 20.12.

## Data sources

### 1. OpenRouter polling (`PROVIDER=openrouter`)
Every `POLL_MS` (default 5 seconds) the server calls OpenRouter's `GET /api/v1/key` and shows:
total used, today / this week / this month, remaining limit, and hourly burn rate.
The cumulative spend chart is built from changes in `usage`. "Today" resets at midnight UTC.

### 2. Proxy (any provider)
Point your app's base URL at the dashboard's proxy:

```python
client = OpenAI(base_url="http://127.0.0.1:8787/proxy/v1", api_key="anything")
```

The proxy forwards requests to `UPSTREAM_BASE` and records input/output tokens, cost (when the upstream reports it, as OpenRouter does), model, and latency for each request. Streaming is supported; for `/chat/completions`, `stream_options.include_usage` is added automatically.
If the client sends no `Authorization`/`x-api-key` header, the proxy uses `API_KEY` from `.env`.

For providers without a balance API (OpenAI, Groq, etc.), use `PROVIDER=none` and the matching `UPSTREAM_BASE`.

History is stored in `data/history.json` (capped at 2000 snapshots and 500 requests).

## Running in the background with pm2

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup   # auto-start after reboot (run the command it prints)
```

Useful commands: `pm2 logs dashboard-token`, `pm2 restart dashboard-token`, `pm2 stop dashboard-token`.
Don't use cluster mode / `instances > 1`: the dashboard's state lives in the memory of a single process.
