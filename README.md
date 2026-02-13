# Spectrum Dashboard

A Cloudflare Worker-based dashboard for monitoring Spectrum usage, connections, and bandwidth.

## Features

- **Real-time monitoring**: View total connections, ingress/egress bandwidth
- **Auto-refresh**: Configurable refresh intervals (30s, 1m, 5m)
- **Per-app statistics**: Toggle between total overview and individual app stats
- **30-day data retention**: Historical data stored in Cloudflare KV
- **Beautiful UI**: Modern glassmorphism design with Chart.js visualizations

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create KV namespace

```bash
# Create production KV namespace
wrangler kv:namespace create "SPECTRUM_DATA"

# Create preview KV namespace (for local dev)
wrangler kv:namespace create "SPECTRUM_DATA" --preview
```

Copy the namespace IDs and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SPECTRUM_DATA"
id = "your-production-kv-id"
preview_id = "your-preview-kv-id"
```

### 3. Set secrets

Store your Cloudflare credentials securely:

```bash
wrangler secret put ACCOUNT_ID
# Enter your Cloudflare Account ID when prompted

wrangler secret put ZONE_ID
# Enter your Zone ID when prompted

wrangler secret put API_KEY
# Enter your Cloudflare API Token when prompted
```

**API Token Requirements:**
- Permission: `Zone > Spectrum > Read`
- Permission: `Account > Analytics > Read`

### 4. Local development

```bash
npm run dev
```

### 5. Deploy

```bash
npm run deploy
```

## Optional: Scheduled data collection

Add to `wrangler.toml` for automatic data collection every hour:

```toml
[triggers]
crons = ["0 * * * *"]
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/latest` | Get latest analytics data |
| `GET /api/refresh` | Fetch fresh data from Cloudflare API and store |
| `GET /api/history?days=30` | Get historical data (up to 30 days) |
| `GET /api/apps` | List all Spectrum applications |

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Dashboard     │────▶│  Worker API     │────▶│ Cloudflare API  │
│   (Frontend)    │     │                 │     │ (Spectrum/      │
│                 │◀────│                 │◀────│  Analytics)     │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │   KV Storage    │
                        │  (30-day TTL)   │
                        └─────────────────┘
```
