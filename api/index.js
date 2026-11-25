'use strict';
const { createApp } = require('../preview/server.js');
let app;

// Vercel keeps the function alive for promises handed to the request context's waitUntil (the mechanism
// @vercel/functions wraps). Used for work after the response: list refresh and deadline checks.
// When it is not available nothing is passed, and the app does that work inside the request instead.
function requestWaitUntil() {
  const context = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
  return typeof context?.waitUntil === 'function' ? context.waitUntil.bind(context) : null;
}

module.exports = async function handler(req, res) {
  if (!process.env.DATABASE_URL) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ code: 'database_required', error: '서비스 저장소 설정이 필요합니다.' }));
  }
  if (!app) {
    const available = Boolean(requestWaitUntil());
    console.log(`[server] waitUntil ${available ? 'available' : 'unavailable: background work runs inline'}`);
    app = createApp(available ? { waitUntil: promise => { const w = requestWaitUntil(); if (w) w(promise); } } : {});
  }
  return app.handler(req, res);
};
