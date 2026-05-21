/**
 * Endpoint Discovery — Finds all data-reading endpoints in the Engram API.
 *
 * Two strategies:
 * 1. Static list of known high-risk endpoints (manually curated)
 * 2. Runtime route introspection from the NestJS app
 *
 * The static list ensures critical endpoints are always tested even if
 * route introspection changes.
 */

import type { INestApplication } from '@nestjs/common';

export interface TestEndpoint {
  method: 'get' | 'post';
  path: string;
  /** Description for test output */
  label: string;
  /** Request body for POST endpoints */
  body?: Record<string, unknown>;
  /** If true, skip gracefully on 404 (parameterized routes without valid IDs) */
  allowNotFound?: boolean;
  /** Priority: 'critical' endpoints leaked in production */
  priority: 'critical' | 'high' | 'normal';
}

/**
 * High-risk endpoints that MUST be tested for RLS isolation.
 * These are manually curated — includes endpoints that already leaked in production.
 */
export const CRITICAL_ENDPOINTS: TestEndpoint[] = [
  // === CRITICAL: These leaked in production (Mar 8, 2026) ===
  {
    method: 'get',
    path: '/v1/dashboard/overview',
    label: 'Dashboard overview (leaked Mar 8)',
    priority: 'critical',
  },
  {
    method: 'get',
    path: '/v1/dashboard/stats',
    label: 'Dashboard stats',
    priority: 'critical',
  },
  {
    method: 'get',
    path: '/v1/awareness/status',
    label: 'Awareness status (leaked Mar 8)',
    priority: 'critical',
  },
  {
    method: 'get',
    path: '/v1/awareness/insights',
    label: 'Awareness insights',
    priority: 'critical',
  },

  // === HIGH: Core data endpoints ===
  {
    method: 'get',
    path: '/v1/memories',
    label: 'List memories',
    priority: 'high',
  },
  {
    method: 'post',
    path: '/v1/memories/query',
    label: 'Query/recall memories',
    body: { query: 'coffee preferences', limit: 20 },
    priority: 'high',
  },
  {
    method: 'post',
    path: '/v1/memories/search',
    label: 'Search memories',
    body: { query: 'work project', limit: 20 },
    priority: 'high',
  },
  {
    method: 'get',
    path: '/v1/memories/search',
    label: 'GET search memories',
    priority: 'high',
  },
  {
    method: 'post',
    path: '/v1/recall',
    label: 'Recall endpoint',
    body: { query: 'morning routine', limit: 20 },
    priority: 'high',
  },
  {
    method: 'post',
    path: '/v1/recall/contextual',
    label: 'Contextual recall',
    body: { query: 'travel plans', limit: 20 },
    priority: 'high',
  },
  {
    method: 'get',
    path: '/v1/graph',
    label: 'Knowledge graph',
    priority: 'high',
  },
  {
    method: 'get',
    path: '/v1/health/metrics',
    label: 'Health metrics (showed wrong counts)',
    priority: 'high',
  },
  {
    method: 'get',
    path: '/v1/analytics',
    label: 'Analytics',
    priority: 'high',
  },

  // === NORMAL: Other data-reading endpoints ===
  {
    method: 'get',
    path: '/v1/memories/export',
    label: 'Export memories',
    priority: 'normal',
  },
  {
    method: 'get',
    path: '/v1/users',
    label: 'List users',
    priority: 'normal',
  },
  {
    method: 'get',
    path: '/v1/clustering',
    label: 'Clustering',
    priority: 'normal',
  },
  {
    method: 'get',
    path: '/v1/dedup/stats',
    label: 'Dedup stats',
    priority: 'normal',
  },
  {
    method: 'get',
    path: '/v1/dedup/candidates',
    label: 'Dedup candidates',
    priority: 'normal',
  },
  {
    method: 'get',
    path: '/v1/hierarchy',
    label: 'Memory hierarchy',
    priority: 'normal',
  },
  {
    method: 'get',
    path: '/v1/scoped-context',
    label: 'Scoped context',
    priority: 'normal',
  },
  {
    method: 'get',
    path: '/v1/multi-query',
    label: 'Multi-query',
    priority: 'normal',
  },
  {
    method: 'get',
    path: '/v1/memory-pool',
    label: 'Memory pool',
    priority: 'normal',
  },
];

/**
 * Discover routes dynamically from a running NestJS application.
 * Falls back to static list if introspection fails.
 */
export function discoverRoutes(app: INestApplication): TestEndpoint[] {
  try {
    const server = app.getHttpServer();
    const router = server._events?.request?._router;

    if (!router?.stack) {
      return CRITICAL_ENDPOINTS;
    }

    const dynamicEndpoints: TestEndpoint[] = [];
    const seenPaths = new Set(
      CRITICAL_ENDPOINTS.map((e) => `${e.method}:${e.path}`),
    );

    for (const layer of router.stack) {
      if (!layer.route) continue;
      const path: string = layer.route.path;
      const methods: string[] = Object.keys(layer.route.methods);

      for (const method of methods) {
        if (method !== 'get' && method !== 'post') continue;
        // Skip paths with params — we test those via the static list
        if (path.includes(':')) continue;
        // Skip non-v1 routes
        if (!path.startsWith('/v1/')) continue;

        const key = `${method}:${path}`;
        if (seenPaths.has(key)) continue;
        seenPaths.add(key);

        dynamicEndpoints.push({
          method: method,
          path,
          label: `[auto-discovered] ${method.toUpperCase()} ${path}`,
          priority: 'normal',
        });
      }
    }

    return [...CRITICAL_ENDPOINTS, ...dynamicEndpoints];
  } catch {
    // If introspection fails, fall back to static list
    return CRITICAL_ENDPOINTS;
  }
}
