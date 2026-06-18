# Feature: Add /hello endpoint to toy-service

Add a `GET /hello` endpoint to `toy-service/` (the single HTTP service in this repo) that returns
`{"message":"hello"}` with HTTP 200. No authentication or authorization required.

## Acceptance criteria

- `GET /hello` returns HTTP 200.
- Response body is `{"message":"hello"}` (valid JSON, `Content-Type: application/json`).
- A unit test covers the happy path.
