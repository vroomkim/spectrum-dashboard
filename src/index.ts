export interface Env {
  ACCOUNT_ID: string;
  ZONE_ID: string;
  API_KEY: string;
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
    appId: string;
    coloName: string;
    date: string;
  };
  sum: {
    bytesIngress: number;
    bytesEgress: number;
  };
  count: number;
  uniq: {
    connections: number;
  };
}

interface StoredData {
  timestamp: string;
  apps: SpectrumApp[];
  analytics: SpectrumAnalytics[];
  totals: {
    bytesIngress: number;
    bytesEgress: number;
    connections: number;
  };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function fetchSpectrumApps(env: Env): Promise<SpectrumApp[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/spectrum/apps`,
    {
      headers: {
        'Authorization': `Bearer ${env.API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  const data = await response.json() as { success: boolean; result: SpectrumApp[] };
  if (!data.success) {
    throw new Error('Failed to fetch Spectrum apps');
  }
  return data.result || [];
}

async function fetchSpectrumAnalytics(env: Env, since: string, until: string): Promise<SpectrumAnalytics[]> {
  const query = `
    query SpectrumAnalytics($accountTag: string!, $filter: ZoneSpectrumApplicationAnalyticsAdaptiveGroupsFilter_InputObject!) {
      viewer {
        zones(filter: { zoneTag: $accountTag }) {
          spectrumApplicationAnalyticsAdaptiveGroups(
            filter: $filter
            limit: 10000
            orderBy: [date_ASC]
          ) {
            dimensions {
              appId
              coloName
              date
            }
            sum {
              bytesIngress
              bytesEgress
            }
            count
            uniq {
              connections
            }
          }
        }
      }
    }
  `;

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: env.ZONE_ID,
        filter: {
          date_geq: since,
          date_leq: until,
        },
      },
    }),
  });

  const data = await response.json() as {
    data?: {
      viewer?: {
        zones?: Array<{
          spectrumApplicationAnalyticsAdaptiveGroups?: SpectrumAnalytics[];
        }>;
      };
    };
  };

  return data.data?.viewer?.zones?.[0]?.spectrumApplicationAnalyticsAdaptiveGroups || [];
}

function calculateTotals(analytics: SpectrumAnalytics[]) {
  return analytics.reduce(
    (acc, item) => ({
      bytesIngress: acc.bytesIngress + (item.sum?.bytesIngress || 0),
      bytesEgress: acc.bytesEgress + (item.sum?.bytesEgress || 0),
      connections: acc.connections + (item.uniq?.connections || 0),
    }),
    { bytesIngress: 0, bytesEgress: 0, connections: 0 }
  );
}

async function storeData(env: Env, data: StoredData): Promise<void> {
  const key = `analytics_${data.timestamp.split('T')[0]}`;
  await env.SPECTRUM_DATA.put(key, JSON.stringify(data), {
    expirationTtl: 60 * 60 * 24 * 30, // 30 days TTL
  });
  await env.SPECTRUM_DATA.put('latest', JSON.stringify(data));
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

      const [apps, analytics] = await Promise.all([
        fetchSpectrumApps(env),
        fetchSpectrumAnalytics(env, since, until),
      ]);

      const totals = calculateTotals(analytics);
      const data: StoredData = {
        timestamp: now.toISOString(),
        apps,
        analytics,
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

    const [apps, analytics] = await Promise.all([
      fetchSpectrumApps(env),
      fetchSpectrumAnalytics(env, since, until),
    ]);

    const totals = calculateTotals(analytics);
    const data: StoredData = {
      timestamp: now.toISOString(),
      apps,
      analytics,
      totals,
    };

    await storeData(env, data);
  },
};
