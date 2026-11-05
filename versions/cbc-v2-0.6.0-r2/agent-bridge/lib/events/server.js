'use strict';

const http = require('node:http');
const { equal } = require('./webhook');
const { RpcError } = require('./service');

function createServer(service, { token, principal = 'ydot' } = {}) {
  if (typeof token !== 'string' || Buffer.byteLength(token) < 32) throw new Error('Provide an authorized ephemeral or operator-managed authentication token');
  const server = http.createServer(async (req, res) => {
    const send = (status, body, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
    // Unknown metadata paths do not advertise an OAuth service; MCP itself stays authenticated. / 未实现的元数据路径不声明OAuth服务；MCP本身仍需认证。
    if (req.url !== '/mcp') return send(404, { error: 'unsupported endpoint' });
    if (!equal(req.headers.authorization, `Bearer ${token}`)) return send(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="codex-events"' });
    if (req.url !== '/mcp' || req.method !== 'POST' || req.headers.origin) return send(404, { error: 'unsupported endpoint or browser origin' });
    if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'JSON required' });
    let message;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 65536) return send(413, { error: 'too large' }); chunks.push(chunk); }
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw new RpcError(-32600, 'Invalid JSON-RPC request');
      if (message.method === 'notifications/initialized' && message.id === undefined) return send(202);
      let result;
      switch (message.method) {
        case 'initialize': result = { protocolVersion: '2025-03-26', capabilities: { events: {}, tools: {} }, serverInfo: { name: 'codex-event-bridge', version: '0.1.0' } }; break;
        case 'ping': result = {}; break;
        case 'events/list': result = service.list(principal); break;
        case 'events/subscribe': result = await service.subscribe(principal, message.params); break;
        case 'events/unsubscribe': result = service.unsubscribe(principal, message.params); break;
        case 'tools/list': result = { tools: [{ name: 'bridge_status', description: 'Read only subscription status for the authenticated principal.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] }; break;
        case 'tools/call':
          if (message.params?.name !== 'bridge_status' || Object.keys(message.params.arguments || {}).length) throw new RpcError(-32602, 'Only read-only bridge_status is supported');
          result = { content: [{ type: 'text', text: JSON.stringify(service.status(principal)) }] }; break;
        default: throw new RpcError(-32601, 'Method not found');
      }
      send(200, { jsonrpc: '2.0', id: message.id ?? null, result });
    } catch (error) {
      send(200, { jsonrpc: '2.0', id: message?.id ?? null, error: { code: error instanceof RpcError ? error.code : -32603,
        message: error instanceof RpcError ? error.reason : 'Request failed', ...(error.code === -32015 ? { data: { reason: error.reason } } : {}) } });
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  return server;
}

module.exports = { createServer };
