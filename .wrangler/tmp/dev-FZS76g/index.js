var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-UZYLYx/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// .wrangler/tmp/bundle-UZYLYx/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// src/index.ts
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
async function fetchSpectrumApps(env) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/spectrum/apps`,
    {
      headers: {
        "Authorization": `Bearer ${env.API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );
  const data = await response.json();
  if (!data.success) {
    throw new Error("Failed to fetch Spectrum apps");
  }
  return data.result || [];
}
__name(fetchSpectrumApps, "fetchSpectrumApps");
async function fetchSpectrumAnalytics(env, since, until) {
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
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: env.ZONE_ID,
        filter: {
          date_geq: since,
          date_leq: until
        }
      }
    })
  });
  const data = await response.json();
  return data.data?.viewer?.zones?.[0]?.spectrumApplicationAnalyticsAdaptiveGroups || [];
}
__name(fetchSpectrumAnalytics, "fetchSpectrumAnalytics");
function calculateTotals(analytics) {
  return analytics.reduce(
    (acc, item) => ({
      bytesIngress: acc.bytesIngress + (item.sum?.bytesIngress || 0),
      bytesEgress: acc.bytesEgress + (item.sum?.bytesEgress || 0),
      connections: acc.connections + (item.uniq?.connections || 0)
    }),
    { bytesIngress: 0, bytesEgress: 0, connections: 0 }
  );
}
__name(calculateTotals, "calculateTotals");
async function storeData(env, data) {
  const key = `analytics_${data.timestamp.split("T")[0]}`;
  await env.SPECTRUM_DATA.put(key, JSON.stringify(data), {
    expirationTtl: 60 * 60 * 24 * 30
    // 30 days TTL
  });
  await env.SPECTRUM_DATA.put("latest", JSON.stringify(data));
}
__name(storeData, "storeData");
async function getHistoricalData(env, days = 30) {
  const results = [];
  const keys = await env.SPECTRUM_DATA.list({ prefix: "analytics_" });
  for (const key of keys.keys) {
    const data = await env.SPECTRUM_DATA.get(key.name);
    if (data) {
      results.push(JSON.parse(data));
    }
  }
  return results.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}
__name(getHistoricalData, "getHistoricalData");
async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  try {
    if (path === "/api/refresh") {
      const now = /* @__PURE__ */ new Date();
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1e3).toISOString().split("T")[0];
      const until = now.toISOString().split("T")[0];
      const [apps, analytics] = await Promise.all([
        fetchSpectrumApps(env),
        fetchSpectrumAnalytics(env, since, until)
      ]);
      const totals = calculateTotals(analytics);
      const data = {
        timestamp: now.toISOString(),
        apps,
        analytics,
        totals
      };
      await storeData(env, data);
      return new Response(JSON.stringify({ success: true, data }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }
    if (path === "/api/latest") {
      const latest = await env.SPECTRUM_DATA.get("latest");
      if (latest) {
        return new Response(latest, {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      }
      return new Response(JSON.stringify({ error: "No data available" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }
    if (path === "/api/history") {
      const days = parseInt(url.searchParams.get("days") || "30");
      const history = await getHistoricalData(env, days);
      return new Response(JSON.stringify({ success: true, data: history }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }
    if (path === "/api/apps") {
      const apps = await fetchSpectrumApps(env);
      return new Response(JSON.stringify({ success: true, data: apps }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  } catch (error) {
    console.error("API Error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }
}
__name(handleApiRequest, "handleApiRequest");
var src_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env);
    }
    return new Response("Not Found", { status: 404 });
  },
  async scheduled(event, env, ctx) {
    const now = /* @__PURE__ */ new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1e3).toISOString().split("T")[0];
    const until = now.toISOString().split("T")[0];
    const [apps, analytics] = await Promise.all([
      fetchSpectrumApps(env),
      fetchSpectrumAnalytics(env, since, until)
    ]);
    const totals = calculateTotals(analytics);
    const data = {
      timestamp: now.toISOString(),
      apps,
      analytics,
      totals
    };
    await storeData(env, data);
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-UZYLYx/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-UZYLYx/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
