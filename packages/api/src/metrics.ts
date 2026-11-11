import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/** Prometheus metrics for the query API. */
export class Metrics {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<"method" | "route" | "status">;
  readonly cacheRequests: Counter<"result">;
  readonly subscriptions: Gauge<string>;
  readonly eventsPublished: Counter<string>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.httpDuration = new Histogram({
      name: "sorex_api_http_request_duration_seconds",
      help: "HTTP request duration",
      labelNames: ["method", "route", "status"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });
    this.cacheRequests = new Counter({
      name: "sorex_api_cache_requests_total",
      help: "Cache lookups by result",
      labelNames: ["result"] as const,
      registers: [this.registry],
    });
    this.subscriptions = new Gauge({
      name: "sorex_api_active_subscriptions",
      help: "Active GraphQL event subscriptions",
      registers: [this.registry],
    });
    this.eventsPublished = new Counter({
      name: "sorex_api_events_published_total",
      help: "Events published to subscription clients",
      registers: [this.registry],
    });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
