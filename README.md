# FichajeBull

Registre de jornada i parts de servei digitals per a empreses de seguretat privada a Espanya. Compleix l'art. 34.9 de l'Estatut dels Treballadors, el RGPD i la LOPDGDD, i el conveni col·lectiu estatal del sector.

- **Web App del vigilant** (`/app/`): PWA *mobile-first* per fitxar amb geolocalització puntual, registrar pauses i prolongacions per demora de relleu, i omplir i signar el part de servei. Funciona sense cobertura.
- **Panell d'oficina** (`/admin/`): dashboard en temps real, quadrants, correccions auditades, còmput mensual i plusos, repositori de parts, exportació per a la Inspecció (Excel/PDF), auditoria i verificació d'integritat.
- **Backend Node.js** amb SQLite natiu (`node:sqlite`). Els registres són immutables a nivell de base de dades i van encadenats amb hash SHA-256.

L'especificació funcional i legal completa, sense codi, és a [`docs/ESPECIFICACIO_FUNCIONAL.md`](docs/ESPECIFICACIO_FUNCIONAL.md).

## Executar amb Docker (Windows, Mac o Linux)

L'aplicació s'exposa al port **3100** del PC, per no xocar amb res que ja corri al 3000.

```bash
git clone -b claude/nice-lamport-mjo9sp https://github.com/jaume08/fichajeBull.git
```

```bash
cd fichajeBull
```

```bash
docker compose up -d --build
```

- Vigilant: http://localhost:3100/app/
- Oficina: http://localhost:3100/admin/

La primera vegada es carreguen les dades de demo. La base de dades es desa al volum `fichaje-data` i es conserva entre reinicis. Per veure els logs: `docker compose logs -f`. Per aturar-lo: `docker compose down`. Per esborrar-ho tot, dades incloses: `docker compose down -v`.

Per canviar el port, edita `"3100:3000"` a `docker-compose.yml`. Canvia també `JWT_SECRET` per una clau pròpia.

## Posada en marxa (sense Docker)

Cal Node.js ≥ 22.13.

```bash
npm install
```

```bash
npm run seed
```

```bash
npm start
```

- Vigilant: http://localhost:3000/app/ (TIP `123456` / `vigilant1`)
- Oficina: http://localhost:3000/admin/ (`ADMIN` / `admin1234`, `RRHH01` / `rrhh12345`, `CECOA1` / `cecoa1234`)

Proves automàtiques:

```bash
npm test
```

### Variables d'entorn

| Variable | Descripció |
|---|---|
| `PORT` | Port HTTP (per defecte 3000). |
| `DB_FILE` | Ruta de la base de dades (per defecte `data/fichaje.sqlite`). |
| `JWT_SECRET` | **Obligatori en producció.** Secret per signar les sessions. |
| `JWT_TTL` | Durada de la sessió (per defecte `14h`). |
| `NODE_ENV` | `production` activa HSTS i exigeix `JWT_SECRET`. |

En producció el servei ha d'anar darrere d'HTTPS: els navegadors només permeten la geolocalització i el *service worker* en contextos segurs.

## Estructura

```
src/
  app.js, server.js        Express, capçaleres de seguretat, rutes
  db.js                    Esquema, triggers d'immutabilitat i retenció, configuració
  auth.js                  Login per TIP, JWT, rols i permisos, limitació d'intents
  realtime.js              Server-Sent Events per al dashboard
  routes/worker.js         API del vigilant (/api/worker/*)
  routes/admin.js          API d'oficina (/api/admin/*)
  services/records.js      Fitxatges: seqüència, geofence, prolongació, pauses, offline, correccions
  services/hours.js        Còmput mensual, nocturnitat, cap de setmana, festius
  services/reports.js      Parts de servei signats
  services/dashboard.js    Estat dels serveis (coberts, retards, absències)
  services/exporter.js     Excel i PDF per a la Inspecció; PDF del part
  services/chain.js        Cadena de hash i verificació d'integritat
  services/nfc.js          Fase 2: lectures NFC (estructura preparada)
  services/retention.js    Purga auditada passats 4 anys
public/app/                PWA del vigilant (service worker + IndexedDB)
public/admin/              Panell d'oficina
docs/                      Especificació funcional i legal; exemple de quadrant CSV
test/                      Proves (node:test)
```

## Importació de quadrants

Format CSV, una línia per torn (separador `;`, `,` o tabulador):

```
TIP;Instal·lació (id o nom);AAAA-MM-DD;HH:MM inici;HH:MM fi;notes
123456;Accés principal;2026-11-01;07:00;19:00;
234567;Garita aparcament (lloc unipersonal);2026-11-01;19:00;07:00;torn de nit
```

Si l'hora de fi és anterior a la d'inici, el torn acaba l'endemà. Hi ha un exemple a `docs/quadrant-exemple.csv`.

## Enviament de parts per correu

L'endpoint `POST /api/admin/reports/:id/send` usa un *mailer* injectable: `createApp({ mailer: async ({ to, subject, attachments }) => {...} })`. Si no n'hi ha cap de configurat, respon 501 i el part es pot descarregar en PDF.
