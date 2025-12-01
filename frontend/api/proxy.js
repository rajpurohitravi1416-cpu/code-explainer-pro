// frontend/api/proxy.js
// Vercel Serverless Function (Node). Receives POST from browser, forwards to Render backend,
// injects secret headers (both Authorization: Bearer and x-api-key) so backend accepts it.

module.exports = async (req, res) => {
  // Only allow POST
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  try {
    // Collect raw body
    let body = '';
    req.on('data', chunk => (body += chunk));
    await new Promise(r => req.on('end', r));
    const parsedBody = body ? JSON.parse(body) : {};

    const BACKEND = process.env.BACKEND_URL || 'https://code-explainer-pro.onrender.com';
    const SECRET = process.env.BACKEND_SECRET || '';

    // Build headers to send to backend.
    // We include both common header forms so the backend can accept either pattern.
    const forwardHeaders = {
      'Content-Type': 'application/json',
      // Include both; backend will use whichever it expects.
      ...(SECRET ? { 'Authorization': `Bearer ${SECRET}`, 'x-api-key': SECRET } : {})
    };

    // Call the backend
    const backendRes = await fetch(`${BACKEND}/explain`, {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(parsedBody),
      // no-cache to be safe
      cache: 'no-store'
    });

    const text = await backendRes.text();

    // Proxy status and headers (preserve content-type if present)
    res.statusCode = backendRes.status;
    const ct = backendRes.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    return res.end(text);
  } catch (err) {
    console.error('proxy error', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'proxy_error', details: String(err) }));
  }
};
