# Liney Home Runner

Home Runner lets `https://liney.namnarak.in.th/app` call the Liney engine on the user's own home server directly over HTTPS. This path does not require a Chrome extension and does not use a Cloudflare Worker relay. The browser stores only the runner URL/token in localStorage; LINE session state stays on the home server runner.

Connect once from the browser with:

```text
https://liney.namnarak.in.th/app?runner=https://cdn.cytechteam.site/liney-runner&runnerToken=<private token>
```

After the first open, the app removes the token from the address bar and keeps it in browser localStorage.

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
