const PAGE_SOURCE = "liney-web-app";
const CONNECTOR_SOURCE = "liney-connector";
const REQUEST_TYPE = "liney.connector.request";
const RESPONSE_TYPE = "liney.connector.response";
const READY_TYPE = "liney.connector.ready";

window.postMessage({
  source: CONNECTOR_SOURCE,
  type: READY_TYPE,
  version: chrome.runtime.getManifest().version
}, window.location.origin);

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data || {};
  if (data.source !== PAGE_SOURCE || data.type !== REQUEST_TYPE || !data.id) return;

  chrome.runtime.sendMessage({
    type: REQUEST_TYPE,
    id: data.id,
    method: data.method,
    params: data.params || {}
  }).then((response) => {
    window.postMessage({
      source: CONNECTOR_SOURCE,
      type: RESPONSE_TYPE,
      id: data.id,
      ok: Boolean(response?.ok),
      result: response?.result,
      error: response?.error
    }, window.location.origin);
  }).catch((error) => {
    window.postMessage({
      source: CONNECTOR_SOURCE,
      type: RESPONSE_TYPE,
      id: data.id,
      ok: false,
      error: {
        message: error?.message || String(error),
        code: "CONNECTOR_UNAVAILABLE",
        retryable: true
      }
    }, window.location.origin);
  });
});
