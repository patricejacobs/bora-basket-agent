/**
 * Every open job on one map, for whoever is dispatching.
 *
 * A dispatcher's picture of the day is a list of order numbers in a chat,
 * read in the order they arrived. What they actually need to know is where
 * the work is: three drops on the East Coast that should go out together,
 * one in Buxton that has been waiting an hour, and a kitchen order whose
 * customer never sent a pin.
 *
 * Deliberately NOT live-tracking anybody. WhatsApp never sends a business
 * number a moving location — only the single pin a customer chose to share —
 * so what this can honestly draw is where each job is GOING, where it is
 * coming FROM, and how long it has been waiting. A page that implied it knew
 * where a van was would be lying.
 *
 * Behind the same token the backup downloads use. This page prints customer
 * names, addresses and telephone numbers, which is the whole reason it is
 * useful and the whole reason it cannot be public: treat the link as the
 * password.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import * as repo from './db/repo.ts';
import { config, money } from './config.ts';

/** Enough length that the URL is not guessable from the outside. */
const TOKEN_MIN = 24;

/** What a pin on the map knows about itself. */
type Job = {
  orderNo: string;
  kind: string;
  status: string;
  customer: string;
  phone: string;
  address: string;
  total: string;
  waitingMinutes: number;
  lat: number | null;
  lng: number | null;
  pickupLat: number | null;
  pickupLng: number | null;
  outlet: string;
  driver: string;
};

const minutesSince = (iso: string): number =>
  Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));

function jobs(): Job[] {
  // A high limit rather than the default ten: a dispatcher wants the whole
  // board, and a shop with more than two hundred open jobs at once has a
  // problem no map will fix.
  return repo.openOrders(200).map((o) => ({
    orderNo: o.orderNo,
    kind: o.kind,
    status: o.status,
    customer: o.recipientName || o.customerName,
    phone: o.recipientPhone || o.contactPhone || o.phone,
    address: o.address,
    total: money(o.total),
    waitingMinutes: minutesSince(o.placedAt),
    lat: o.location?.latitude ?? null,
    lng: o.location?.longitude ?? null,
    pickupLat: o.pickup?.latitude ?? null,
    pickupLng: o.pickup?.longitude ?? null,
    outlet: o.outlet?.name ?? '',
    driver: o.driverName || '',
  }));
}

/**
 * The page.
 *
 * One file, no build step, Leaflet from a CDN, and the data fetched
 * separately so the map can refresh itself without reloading. It has to
 * work on the phone of somebody standing in a shop, which is why the list
 * sits under the map rather than beside it.
 */
function page(key: string): string {
  // The shop's own area if it has drawn one, Georgetown otherwise. Only the
  // opening view: the map fits itself to the jobs the moment there are any.
  const area = config.store.serviceArea;
  const centre = `${area?.latitude ?? 6.8013}, ${area?.longitude ?? -58.1551}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Dispatch — ${config.store.name}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"></script>
<style>
  :root { color-scheme: light dark; --ink:#111; --paper:#fff; --line:#d8d8d8; --dim:#666; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#eee; --paper:#171717; --line:#333; --dim:#999; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
         background:var(--paper); color:var(--ink); }
  header { padding:10px 16px; border-bottom:1px solid var(--line);
           display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:650; }
  .count { color:var(--dim); font-size:13px; }
  #map { height:58vh; width:100%; }
  .list { padding:8px 16px 48px; }
  .job { padding:10px 0; border-bottom:1px solid var(--line); }
  .job b { font-weight:650; }
  .meta { color:var(--dim); font-size:13px; }
  .nopin { color:#b45309; font-size:13px; }
  a { color:inherit; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; }
</style>
</head>
<body>
<header>
  <h1>${config.store.name} — dispatch</h1>
  <span class="count" id="count">loading…</span>
  <label class="count">delivered
    <select id="days">
      <option value="0">off</option>
      <option value="1">today</option>
      <option value="7" selected>7 days</option>
      <option value="30">30 days</option>
    </select>
  </label>
  <span class="count" id="done"></span>
  <span class="count" id="when"></span>
</header>
<div id="map"></div>
<div class="list" id="list"></div>
<script>
  var KEY = ${JSON.stringify(key)};
  var COLOUR = { pending: '#dc2626', confirmed: '#f59e0b', ready: '#2563eb', on_the_way: '#16a34a' };
  var map = L.map('map').setView([${centre}], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  var layer = L.layerGroup().addTo(map);
  // NOT "history": a top-level var of that name does not shadow
  // window.history, it silently fails to assign over it - and then
  // history.clearLayers() throws, the draw dies, and the page says
  // "offline" over a perfectly good map and a working endpoint.
  var doneLayer = L.layerGroup().addTo(map);
  var fitted = false;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function draw(data) {
    layer.clearLayers();
    doneLayer.clearLayers();

    // Drawn first, so a live job is never hidden under a finished one. Small,
    // grey and unlabelled until tapped: this is the shape of the week, not
    // work anybody has to do.
    data.done.forEach(function (d) {
      L.circleMarker([d.lat, d.lng], {
        radius: 4, color: '#64748b', weight: 1, fillColor: '#94a3b8', fillOpacity: 0.5
      }).addTo(doneLayer).bindPopup(
        '<b>' + esc(d.orderNo) + '</b> — delivered<br>' + esc(d.customer) + '<br>' +
        esc(d.address || '') + '<br>' + esc(d.total) + '<br>' +
        new Date(d.when).toLocaleString()
      );
    });
    document.getElementById('done').textContent = data.days > 0
      ? data.done.length + ' delivered · ' + data.doneValue
      : '';
    var points = [];
    var rows = '';
    data.jobs.forEach(function (j) {
      var colour = COLOUR[j.status] || '#6b7280';
      var late = j.waitingMinutes >= 45;
      if (j.lat !== null && j.lng !== null) {
        points.push([j.lat, j.lng]);
        L.circleMarker([j.lat, j.lng], {
          radius: late ? 11 : 8, color: colour, weight: late ? 3 : 2,
          fillColor: colour, fillOpacity: 0.65
        }).addTo(layer).bindPopup(
          '<b>' + esc(j.orderNo) + '</b> — ' + esc(j.status.replace(/_/g, ' ')) + '<br>' +
          esc(j.customer) + '<br>' + esc(j.address || 'no address written') + '<br>' +
          '<a href="tel:+' + esc(j.phone) + '">+' + esc(j.phone) + '</a><br>' +
          esc(j.total) + ' · ' + j.waitingMinutes + ' min' +
          (j.driver ? '<br>with ' + esc(j.driver) : '<br><i>nobody has it</i>')
        );
      }
      if (j.pickupLat !== null && j.pickupLng !== null) {
        points.push([j.pickupLat, j.pickupLng]);
        L.circleMarker([j.pickupLat, j.pickupLng], {
          radius: 5, color: '#6b7280', weight: 1, fillColor: '#fff', fillOpacity: 1
        }).addTo(layer).bindPopup('Uplift for <b>' + esc(j.orderNo) + '</b><br>' + esc(j.outlet));
      }
      rows += '<div class="job"><b><span class="dot" style="background:' + colour + '"></span>' +
        esc(j.orderNo) + '</b> ' + esc(j.customer) +
        '<div class="meta">' + esc(j.address || '—') + ' · ' + esc(j.total) + ' · ' +
        j.waitingMinutes + ' min' + (j.driver ? ' · ' + esc(j.driver) : ' · nobody has it') +
        '</div>' +
        (j.lat === null ? '<div class="nopin">no pin — ring before setting off</div>' : '') +
        '</div>';
    });
    document.getElementById('list').innerHTML = rows ||
      '<div class="job">Nothing open. Everything is delivered or cancelled.</div>';
    document.getElementById('count').textContent =
      data.jobs.length + ' open · ' + data.withoutPin + ' with no pin';
    document.getElementById('when').textContent =
      'updated ' + new Date().toLocaleTimeString();
    if (!fitted && points.length > 0) { map.fitBounds(points, { padding: [40, 40] }); fitted = true; }
  }

  function DAYS() { return document.getElementById('days').value; }

  function load() {
    // An ABSOLUTE path. Relative, from /dispatch with no trailing slash, it
    // resolved to /data - which is not this router, and the page sat there
    // saying "offline" over a perfectly good map.
    fetch('/dispatch/data?key=' + encodeURIComponent(KEY) + '&days=' + DAYS(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(draw)
      .catch(function () { document.getElementById('when').textContent = 'offline'; });
  }
  document.getElementById('days').addEventListener('change', load);
  load();
  setInterval(load, 20000);
</script>
</body>
</html>`;
}

/**
 * Mounts /dispatch, or says why it is off.
 *
 * Shares BACKUP_TOKEN rather than inventing a second secret. They guard the
 * same thing — every customer the shop has — and a shop with two admin
 * passwords has one it has forgotten to rotate.
 */
export function mountDispatchMap(app: express.Express): void {
  const token = config.backup.token;
  if (!token || token.length < TOKEN_MIN) {
    console.log('[dispatch] BACKUP_TOKEN is not set (or is too short) — the map is off');
    return;
  }

  const expected = Buffer.from(token, 'utf8');
  const authorised = (req: Request): boolean => {
    const header = req.get('authorization') ?? '';
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const supplied = bearer || String(req.query.key ?? '');
    if (!supplied) return false;
    const given = Buffer.from(supplied, 'utf8');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };

  const router = express.Router();
  router.use((req: Request, res: Response, next: NextFunction) => {
    // 404, not 403: an unauthorised caller learns nothing about what is here.
    if (!authorised(req)) {
      res.sendStatus(404);
      return;
    }
    res.set('Cache-Control', 'no-store, private');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });

  router.get('/', (req: Request, res: Response) => {
    res.type('html').send(page(String(req.query.key ?? '')));
  });

  router.get('/data', (req: Request, res: Response) => {
    const open = jobs();
    // Days of history, asked for by the page. Zero means do not look: the
    // query is bounded, but a dispatcher who only wants today's work should
    // not pay for a month of it on a phone connection.
    const days = Math.min(90, Math.max(0, Number(req.query.days ?? 0) || 0));
    const done = days > 0 ? repo.deliveredSince(days) : [];

    res.json({
      jobs: open,
      withoutPin: open.filter((j) => j.lat === null).length,
      days,
      done: done.map((o) => ({
        orderNo: o.orderNo,
        customer: o.recipientName || o.customerName,
        address: o.address,
        total: money(o.total),
        lat: o.location?.latitude ?? null,
        lng: o.location?.longitude ?? null,
        when: repo.deliveredAt(o.orderNo) || o.placedAt,
      })),
      doneValue: money(done.reduce((sum, o) => sum + o.total, 0)),
      at: new Date().toISOString(),
    });
  });

  app.use('/dispatch', router);
  console.log('[dispatch] map on at /dispatch?key=…');
}
