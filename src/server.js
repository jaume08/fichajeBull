'use strict';
const { createApp } = require('./app');
const dbm = require('./db');

dbm.get();
const port = Number(process.env.PORT) || 3000;
createApp().listen(port, () => console.log(`FichajeBull escoltant a http://localhost:${port}  (vigilant: /app/  ·  oficina: /admin/)`));
