# Liney Home Runner

Runs the existing Liney JSONL engine on a user-owned machine and exposes a small authenticated HTTP RPC bridge for Liney Web/Connector.

Default local URL:

```text
http://127.0.0.1:39211/liney-runner
```

Public tunnel path used by the home server deployment:

```text
https://cdn.cytechteam.site/liney-runner
```

Requests to `/rpc` require `Authorization: Bearer <LINEY_RUNNER_TOKEN>` or `X-Liney-Runner-Token`.
