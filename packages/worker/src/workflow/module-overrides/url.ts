/* eslint-disable import/unambiguous */
// Only expose the WHATWG URL API (URLPattern is only defined on Node 23.8+)
module.exports = { URL, URLSearchParams, URLPattern: (globalThis as { URLPattern?: unknown }).URLPattern };
