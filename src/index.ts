export interface Env {
  ACCOUNT_ID: string;
  ZONE_ID: string;
  API_KEY: string;
  AUTH_EMAIL: string;
  SPECTRUM_DATA: KVNamespace;
}

interface SpectrumApp {
  id: string;
  protocol: string;
  dns: { type: string; name: string };
  origin_direct?: string[];
  origin_dns?: { name: string };
  ip_firewall: boolean;
  proxy_protocol: string;
  created_on: string;
  modified_on: string;
}

interface SpectrumAnalytics {
  dimensions: {
    applicationTag: string;
    coloName: string;
    date: string;
    outcome: string;
  };
  sum: {
    bits: number;
    packets: number;
  };
}

interface CurrentSession {
  appID: string;
  bytesEgress: number;
  bytesIngress: number;
  connections: number;
  durationAvg: number;
}

interface StoredData {
  timestamp: string;
  apps: SpectrumApp[];
  analytics: SpectrumAnalytics[];
  currentSessions: CurrentSession[];
  totals: {
    bits: number;
    packets: number;
    connections: number;
    bytesIngress: number;
    bytesEgress: number;
  };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function fetchSpectrumApps(env: Env): Promise<SpectrumApp[]> {
  const url = `https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/spectrum/apps`;
  const response = await fetch(url, {
    headers: {
      'X-Auth-Key': env.API_KEY,
      'X-Auth-Email': env.AUTH_EMAIL,
      'Content-Type': 'application/json',
    },
  });
  const text = await response.text();
  let data: { success: boolean; result: SpectrumApp[]; errors?: Array<{message: string; code?: number}> };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Failed to parse response: ${text.substring(0, 200)}`);
  }
  if (!data.success) {
    const errorMsg = data.errors?.map(e => `${e.message} (code: ${e.code})`).join(', ') || `Unknown error. Status: ${response.status}`;
    throw new Error(`Spectrum API error: ${errorMsg}. URL: ${url}`);
  }
  return data.result || [];
}

async function fetchSpectrumAnalytics(env: Env, since: string, until: string): Promise<SpectrumAnalytics[]> {
  const query = `
    query SpectrumAnalytics($accountTag: string!, $filter: AccountSpectrumNetworkAnalyticsAdaptiveGroupsFilter_InputObject!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          spectrumNetworkAnalyticsAdaptiveGroups(
            filter: $filter
            limit: 10000
            orderBy: [date_ASC]
          ) {
            dimensions {
              applicationTag
              coloName
              date
              outcome
            }
            sum {
              bits
              packets
            }
          }
        }
      }
    }
  `;

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'X-Auth-Key': env.API_KEY,
      'X-Auth-Email': env.AUTH_EMAIL,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: env.ACCOUNT_ID,
        filter: {
          date_geq: since,
          date_leq: until,
        },
      },
    }),
  });

  const text = await response.text();
  let data: {
    data?: {
      viewer?: {
        accounts?: Array<{
          spectrumNetworkAnalyticsAdaptiveGroups?: SpectrumAnalytics[];
        }>;
      };
    };
    errors?: Array<{message: string}>;
  };
  
  try {
    data = JSON.parse(text);
  } catch {
    console.error('GraphQL parse error:', text.substring(0, 500));
    return [];
  }

  if (data.errors) {
    console.error('GraphQL errors:', JSON.stringify(data.errors));
  }

  return data.data?.viewer?.accounts?.[0]?.spectrumNetworkAnalyticsAdaptiveGroups || [];
}

async function fetchCurrentSessions(env: Env): Promise<CurrentSession[]> {
  const url = `https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/spectrum/analytics/aggregate/current`;
  const response = await fetch(url, {
    headers: {
      'X-Auth-Key': env.API_KEY,
      'X-Auth-Email': env.AUTH_EMAIL,
      'Content-Type': 'application/json',
    },
  });
  const text = await response.text();
  let data: { success: boolean; result: CurrentSession[]; errors?: Array<{message: string}> };
  try {
    data = JSON.parse(text);
  } catch {
    console.error('Current sessions parse error:', text.substring(0, 500));
    return [];
  }
  if (!data.success) {
    console.error('Current sessions API error:', data.errors);
    return [];
  }
  return data.result || [];
}

function calculateTotals(analytics: SpectrumAnalytics[], currentSessions: CurrentSession[]) {
  const analyticsTotal = analytics.reduce(
    (acc, item) => ({
      bits: acc.bits + (item.sum?.bits || 0),
      packets: acc.packets + (item.sum?.packets || 0),
    }),
    { bits: 0, packets: 0 }
  );

  const sessionTotal = currentSessions.reduce(
    (acc, item) => ({
      connections: acc.connections + (item.connections || 0),
      bytesIngress: acc.bytesIngress + (item.bytesIngress || 0),
      bytesEgress: acc.bytesEgress + (item.bytesEgress || 0),
    }),
    { connections: 0, bytesIngress: 0, bytesEgress: 0 }
  );

  return {
    bits: analyticsTotal.bits,
    packets: analyticsTotal.packets,
    connections: sessionTotal.connections,
    bytesIngress: sessionTotal.bytesIngress,
    bytesEgress: sessionTotal.bytesEgress,
  };
}

interface TimeSeriesPoint {
  timestamp: string;
  connections: number;
  bytesIngress: number;
  bytesEgress: number;
  perApp: { [appId: string]: { connections: number; bytesIngress: number; bytesEgress: number } };
}

async function storeData(env: Env, data: StoredData): Promise<void> {
  // Store latest full data
  await env.SPECTRUM_DATA.put('latest', JSON.stringify(data));

  // Store time series point for charts
  const point: TimeSeriesPoint = {
    timestamp: data.timestamp,
    connections: data.totals.connections,
    bytesIngress: data.totals.bytesIngress,
    bytesEgress: data.totals.bytesEgress,
    perApp: {}
  };

  // Add per-app data
  (data.currentSessions || []).forEach(s => {
    point.perApp[s.appID] = {
      connections: s.connections,
      bytesIngress: s.bytesIngress,
      bytesEgress: s.bytesEgress
    };
  });

  // Get existing time series and append new point
  const timeSeriesKey = 'timeseries';
  const existing = await env.SPECTRUM_DATA.get(timeSeriesKey);
  let timeSeries: TimeSeriesPoint[] = existing ? JSON.parse(existing) : [];
  
  // Keep last 200 data points (about 50 min at 15s refresh)
  timeSeries.push(point);
  if (timeSeries.length > 200) {
    timeSeries = timeSeries.slice(-200);
  }

  await env.SPECTRUM_DATA.put(timeSeriesKey, JSON.stringify(timeSeries), {
    expirationTtl: 60 * 60 * 24, // 24 hours TTL
  });
}

async function getHistoricalData(env: Env, days: number = 30): Promise<StoredData[]> {
  const results: StoredData[] = [];
  const keys = await env.SPECTRUM_DATA.list({ prefix: 'analytics_' });
  
  for (const key of keys.keys) {
    const data = await env.SPECTRUM_DATA.get(key.name);
    if (data) {
      results.push(JSON.parse(data));
    }
  }
  
  return results.sort((a, b) => 
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    if (path === '/api/refresh') {
      const now = new Date();
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const until = now.toISOString().split('T')[0];

      const [apps, analytics, currentSessions] = await Promise.all([
        fetchSpectrumApps(env),
        fetchSpectrumAnalytics(env, since, until),
        fetchCurrentSessions(env),
      ]);

      const totals = calculateTotals(analytics, currentSessions);
      const data: StoredData = {
        timestamp: now.toISOString(),
        apps,
        analytics,
        currentSessions,
        totals,
      };

      await storeData(env, data);

      return new Response(JSON.stringify({ success: true, data }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    if (path === '/api/latest') {
      const latest = await env.SPECTRUM_DATA.get('latest');
      if (latest) {
        return new Response(latest, {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
      return new Response(JSON.stringify({ error: 'No data available' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    if (path === '/api/history') {
      const days = parseInt(url.searchParams.get('days') || '30');
      const history = await getHistoricalData(env, days);
      return new Response(JSON.stringify({ success: true, data: history }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    if (path === '/api/timeseries') {
      const timeSeries = await env.SPECTRUM_DATA.get('timeseries');
      return new Response(JSON.stringify({ success: true, data: timeSeries ? JSON.parse(timeSeries) : [] }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    if (path === '/api/apps') {
      const apps = await fetchSpectrumApps(env);
      return new Response(JSON.stringify({ success: true, data: apps }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  } catch (error) {
    console.error('API Error:', error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }

    // Static assets are served automatically by wrangler's [assets] config
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const until = now.toISOString().split('T')[0];

    const [apps, analytics, currentSessions] = await Promise.all([
      fetchSpectrumApps(env),
      fetchSpectrumAnalytics(env, since, until),
      fetchCurrentSessions(env),
    ]);

    const totals = calculateTotals(analytics, currentSessions);
    const data: StoredData = {
      timestamp: now.toISOString(),
      apps,
      analytics,
      currentSessions,
      totals,
    };

    await storeData(env, data);
  },
};
