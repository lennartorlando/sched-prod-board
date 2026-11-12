// Runs only for /media/* (wrangler.jsonc, run_worker_first). Static assets answer a Range
// request with 200 and the whole file; video players such as Safari's need 206.
// Everything else is served by the assets binding unchanged.

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null; // not a single range: ignore it
  if (match[1] === '') {
    const length = Math.min(Number(match[2]), size);
    return length === 0 ? { unsatisfiable: true } : { start: size - length, end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return { unsatisfiable: true };
  return { start, end };
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return env.ASSETS.fetch(request);
    const asset = await env.ASSETS.fetch(new Request(request.url, { method: 'GET' }));
    if (asset.status !== 200) return asset;

    const body = await asset.arrayBuffer();
    const size = body.byteLength;
    const headers = new Headers(asset.headers);
    headers.set('accept-ranges', 'bytes');

    const header = request.headers.get('range');
    const range = header ? parseRange(header, size) : null;
    if (!range) {
      headers.set('content-length', String(size));
      return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
    }
    if (range.unsatisfiable) {
      headers.set('content-range', `bytes */${size}`);
      headers.delete('content-length');
      return new Response(null, { status: 416, headers });
    }
    const slice = body.slice(range.start, range.end + 1);
    headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('content-length', String(slice.byteLength));
    return new Response(request.method === 'HEAD' ? null : slice, { status: 206, headers });
  },
};
