const memCache = new Map()
const CACHEABLE_ROUTES = [
  { prefix: '/api/tasks/all', namespace: 'tasks_all', ttl: 60 },
  { prefix: '/api/tasks/assets', namespace: 'tasks_assets', ttl: 90 },
]

function splitCsv(value) {
  return `${value || ''}`
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false

  const configuredOrigins = [
    ...splitCsv(env.FRONTEND_URL),
    ...splitCsv(env.CORS_ORIGINS),
  ]
  if (configuredOrigins.includes(origin)) {
    return true
  }

  try {
    const url = new URL(origin)
    const host = (url.hostname || '').toLowerCase()
    return (
      /^https:\/\/.*\.onrender\.com$/i.test(origin)
      || /^https:\/\/.*\.workers\.dev$/i.test(origin)
      || host === 'localhost'
      || host === '127.0.0.1'
      || host.startsWith('192.168.')
    )
  } catch {
    return false
  }
}

function applyCorsHeaders(headers, request, env) {
  const nextHeaders = new Headers(headers || {})
  const origin = request.headers.get('Origin')

  if (!origin || !isAllowedOrigin(origin, env)) {
    return nextHeaders
  }

  nextHeaders.set('Access-Control-Allow-Origin', origin)
  nextHeaders.set('Access-Control-Allow-Credentials', 'true')
  nextHeaders.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  nextHeaders.set(
    'Access-Control-Allow-Headers',
    request.headers.get('Access-Control-Request-Headers') || 'Content-Type, X-Session-Id',
  )
  nextHeaders.set('Access-Control-Expose-Headers', 'Set-Cookie, X-Cache')
  nextHeaders.append('Vary', 'Origin')

  return nextHeaders
}

function withCors(response, request, env) {
  const headers = applyCorsHeaders(response.headers, request, env)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function handleCorsPreflight(request, env) {
  const headers = applyCorsHeaders({}, request, env)
  if (!headers.has('Access-Control-Allow-Origin')) {
    return new Response(null, { status: 403 })
  }
  return new Response(null, { status: 204, headers })
}

function json(data, init = {}) {
  const headers = new Headers(init.headers || {})
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8')
  }

  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  })
}

function getRouteConfig(pathname) {
  return CACHEABLE_ROUTES.find((route) => pathname.startsWith(route.prefix)) || null
}

function getSessionValue(request) {
  return request.headers.get('X-Session-Id') || 'public'
}

async function hashText(value) {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 20)
}

async function buildCacheKey(url, request, route) {
  const sessionHash = await hashText(getSessionValue(request))
  return `${route.namespace}:${url.pathname}${url.search}:${sessionHash}`
}

function buildOriginRequest(request, env, url) {
  const originUrl = new URL(url.pathname + url.search, env.FASTAPI_URL)
  return new Request(originUrl.toString(), request)
}

function setCacheHeaders(headers, cacheStatus, ttl) {
  const nextHeaders = new Headers(headers || {})
  nextHeaders.set('X-Cache', cacheStatus)
  nextHeaders.set('Cache-Control', `public, max-age=${Math.min(ttl, 30)}, s-maxage=${ttl}`)
  return nextHeaders
}

function writeMemCache(key, data, ttl, status = 200) {
  memCache.set(key, {
    data,
    status,
    exp: Date.now() + Math.min(ttl * 1000, 30_000),
  })
}

function readMemCache(key) {
  const cached = memCache.get(key)
  if (!cached) return null
  if (cached.exp <= Date.now()) {
    memCache.delete(key)
    return null
  }
  return cached
}

async function proxyToOrigin(request, env, url) {
  return fetch(buildOriginRequest(request, env, url))
}

async function cacheOriginJson(request, env, url, route, cacheKey) {
  const response = await proxyToOrigin(request, env, url)
  if (!response.ok) {
    return response
  }

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    return response
  }

  const data = await response.json()
  const ttl = route.ttl

  if (env.DASHBOARD_KV) {
    await env.DASHBOARD_KV.put(cacheKey, JSON.stringify(data), {
      expirationTtl: ttl,
    })
  }
  writeMemCache(cacheKey, data, ttl, response.status)

  return json(data, {
    status: response.status,
    headers: setCacheHeaders(response.headers, 'MISS', ttl),
  })
}

async function handleCachedGet(request, env, url, route) {
  const cacheKey = await buildCacheKey(url, request, route)
  const mem = readMemCache(cacheKey)
  if (mem) {
    return json(mem.data, {
      status: mem.status,
      headers: setCacheHeaders({}, 'HIT-MEM', route.ttl),
    })
  }

  if (env.DASHBOARD_KV) {
    const kvData = await env.DASHBOARD_KV.get(cacheKey, { type: 'json' })
    if (kvData) {
      writeMemCache(cacheKey, kvData, route.ttl)
      return json(kvData, {
        status: 200,
        headers: setCacheHeaders({}, 'HIT-KV', route.ttl),
      })
    }
  }

  return cacheOriginJson(request, env, url, route, cacheKey)
}

async function purgeKvPrefix(env, prefix) {
  if (!env.DASHBOARD_KV || !prefix) return 0

  let cursor = undefined
  let deleted = 0

  do {
    const page = await env.DASHBOARD_KV.list({ prefix, cursor })
    cursor = page.list_complete ? undefined : page.cursor
    for (const key of page.keys) {
      await env.DASHBOARD_KV.delete(key.name)
      deleted += 1
    }
  } while (cursor)

  return deleted
}

async function handlePurge(request, env) {
  const secret = request.headers.get('X-Purge-Secret')
  if (!secret || secret !== env.PURGE_SECRET) {
    return json({ success: false, message: 'Unauthorized' }, { status: 401 })
  }

  const payload = await request.json().catch(() => ({}))
  const patterns = Array.isArray(payload?.patterns)
    ? payload.patterns.map((pattern) => `${pattern || ''}`.trim()).filter(Boolean)
    : []

  let deleted = 0
  for (const pattern of patterns) {
    deleted += await purgeKvPrefix(env, pattern)
  }

  for (const key of Array.from(memCache.keys())) {
    if (patterns.some((pattern) => key.startsWith(pattern))) {
      memCache.delete(key)
    }
  }

  return json({
    success: true,
    deleted,
    patterns,
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const isWebSocketUpgrade = request.headers.get('Upgrade') === 'websocket'
    const route = getRouteConfig(url.pathname)

    if (request.method === 'OPTIONS' && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/edge/'))) {
      return handleCorsPreflight(request, env)
    }

    if (url.pathname === '/edge/health') {
      return withCors(json({
        ok: true,
        route: '/edge/health',
        fastapiUrl: env.FASTAPI_URL || null,
        hyperdriveBound: Boolean(env.HYPERDRIVE),
        kvBound: Boolean(env.DASHBOARD_KV),
        timestamp: new Date().toISOString(),
      }), request, env)
    }

    if ((url.pathname === '/edge/purge' || url.pathname === '/purge') && request.method === 'POST') {
      return withCors(await handlePurge(request, env), request, env)
    }

    if (url.pathname.startsWith('/api/')) {
      if (isWebSocketUpgrade) {
        return proxyToOrigin(request, env, url)
      }
      if (request.method === 'GET' && route) {
        return withCors(await handleCachedGet(request, env, url, route), request, env)
      }
      return withCors(await proxyToOrigin(request, env, url), request, env)
    }

    if (url.pathname.startsWith('/edge/')) {
      return withCors(json(
        {
          ok: false,
          message: 'Unknown edge route',
        },
        { status: 404 },
      ), request, env)
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request)
    }

    return new Response('Not found', { status: 404 })
  },
}
