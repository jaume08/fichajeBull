'use strict';
const express = require('express');
const path = require('node:path');
const auth = require('./auth');
const audit = require('./services/audit');
const dbm = require('./db');
const { h, ip } = require('./routes/util');

function createApp({ mailer = null } = {}) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.set('mailer', mailer);
  app.disable('x-powered-by');

  // Capçaleres de seguretat
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    });
    if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.post('/api/login', h((req, res) => {
    const out = auth.login(req.body.tip, req.body.password, ip(req));
    if (out.error) {
      audit.log(dbm.get(), { action: 'login.failed', details: { tip: String(req.body.tip || '').slice(0, 32) }, ip: ip(req) });
      return res.status(out.status).json({ error: out.error });
    }
    audit.log(dbm.get(), { actorId: out.user.id, action: 'login', ip: ip(req) });
    res.json(out);
  }));

  app.use('/api/worker', require('./routes/worker'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'No trobat' }));

  const pub = path.join(__dirname, '..', 'public');
  app.get('/', (req, res) => res.redirect('/app/'));
  app.get('/app/sw.js', (req, res) => res.set('Service-Worker-Allowed', '/app/').sendFile(path.join(pub, 'app', 'sw.js')));
  app.use(express.static(pub, { index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Error intern del servidor' });
  });
  return app;
}

module.exports = { createApp };
