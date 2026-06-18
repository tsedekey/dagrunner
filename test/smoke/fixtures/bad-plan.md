# Feature: Add greeting endpoint

Users should be able to call GET /hello and receive a JSON greeting.

## Acceptance criteria

- GET /hello returns `{"message": "hello"}`

## Proposed implementation

Introduce a `GreetingService` class with a `computeGreeting()` method and a
`GreetingCache` backed by an in-memory LRU eviction map (TTL 60 s) to avoid
recomputing the same greeting string multiple times. The handler must acquire a
`ReentrantLock` before delegating to `GreetingService` to avoid concurrent
modification of the cache. Wire a circuit-breaker with exponential backoff (base 100
ms, max 5 retries) around the service call in case the greeting computation fails.
Add a `GreetingMetricsCollector` Micrometer bean that emits `greeting.calls.total`
and `greeting.latency.p99` gauges. Implement a `GreetingHealthIndicator` Spring Boot
Actuator bean that reports UP/DOWN based on whether the last greeting call succeeded.
Add JWT validation to the endpoint even though auth is not a requirement, to future-
proof the API for later.
