// ============================================================
// booking.js — Prise de rendez-vous : réglages, fuseau horaire, créneaux
// ============================================================
// Uniquement de la logique "pure" (aucun accès à la base ici), pour pouvoir
// la tester facilement. Les routes qui lisent/écrivent la base sont dans
// server.js.
//
// Toutes les heures affichées aux visiteurs et aux commerçants sont en
// heure de Paris, même si le serveur Render tourne en heure UTC : on
// convertit explicitement, sans dépendre du fuseau de la machine.

const TIMEZONE = 'Europe/Paris';

// Jours de la semaine, dans l'ordre de JavaScript (0 = dimanche).
const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

function defaultBooking() {
  return {
    enabled: false,
    // 'link' = simple renvoi vers la page de réservation du client (Calendly,
    // Planity, TheFork…) ; 'agenda' = créneaux calculés et réservés dans le chat.
    mode: 'link',
    linkUrl: '',
    services: [], // [{ id, name, duration (minutes), price (texte libre, ex "35 €") }]
    // Horaires par jour (clé 0..6, 0 = dimanche). Texte libre du type
    // "09:00-12:00, 14:00-19:00" — plusieurs plages possibles (pause
    // déjeuner, service du midi et du soir pour un restaurant…). Vide = fermé.
    hours: { 0: '', 1: '', 2: '09:00-19:00', 3: '09:00-19:00', 4: '09:00-19:00', 5: '09:00-19:00', 6: '09:00-18:00' },
    capacity: 1,        // nombre de rendez-vous possibles en même temps (coiffeurs, tables…)
    slotStep: 30,       // un créneau proposé toutes les X minutes
    minNoticeHours: 2,  // délai minimum avant un rendez-vous
    maxDaysAhead: 30,   // jusqu'à combien de jours à l'avance on peut réserver
  };
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// Lit et nettoie les réglages enregistrés en base (JSON), en complétant
// avec les valeurs par défaut. Ne plante jamais, même sur un JSON abîmé.
function parseBooking(business) {
  const d = defaultBooking();
  let raw = {};
  try { raw = JSON.parse((business && business.booking) || '{}') || {}; } catch { raw = {}; }
  return sanitizeBooking(raw, d);
}

function sanitizeBooking(raw, d = defaultBooking()) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const services = Array.isArray(raw.services)
    ? raw.services
        .filter((s) => s && String(s.name || '').trim())
        .slice(0, 40)
        .map((s) => ({
          id: String(s.id || ('s' + Math.random().toString(36).slice(2, 9))).slice(0, 20),
          name: String(s.name).trim().slice(0, 80),
          duration: clampInt(s.duration, 5, 600, 30),
          price: String(s.price || '').trim().slice(0, 30),
        }))
    : d.services;

  const hours = {};
  for (let i = 0; i < 7; i++) {
    const v = raw.hours && raw.hours[i] !== undefined ? raw.hours[i] : d.hours[i];
    hours[i] = String(v || '').trim().slice(0, 60);
  }

  // Réglages enregistrés avant l'ajout du mode "lien" : c'était forcément l'agenda.
  let mode = raw.mode === 'agenda' || raw.mode === 'link' ? raw.mode
    : (raw.enabled && Array.isArray(raw.services) && raw.services.length ? 'agenda' : d.mode);
  let linkUrl = String(raw.linkUrl || '').trim().slice(0, 500);
  if (linkUrl && !/^https:\/\/[^\s]+\.[^\s]+/i.test(linkUrl)) linkUrl = '';

  return {
    enabled: raw.enabled === undefined ? d.enabled : !!raw.enabled,
    mode,
    linkUrl,
    services,
    hours,
    capacity: clampInt(raw.capacity, 1, 50, d.capacity),
    slotStep: clampInt(raw.slotStep, 5, 120, d.slotStep),
    minNoticeHours: clampInt(raw.minNoticeHours, 0, 168, d.minNoticeHours),
    maxDaysAhead: clampInt(raw.maxDaysAhead, 1, 180, d.maxDaysAhead),
  };
}

// "09:00-12:00, 14:00-19:00" → [[540, 720], [840, 1140]] (minutes depuis minuit).
// Les plages invalides sont simplement ignorées.
function parseRanges(text) {
  const ranges = [];
  String(text || '').split(/[,;]/).forEach((part) => {
    const m = part.trim().match(/^(\d{1,2})[:hH]?(\d{2})?\s*[-–à]\s*(\d{1,2})[:hH]?(\d{2})?$/);
    if (!m) return;
    const start = Number(m[1]) * 60 + Number(m[2] || 0);
    const end = Number(m[3]) * 60 + Number(m[4] || 0);
    if (start < end && end <= 24 * 60) ranges.push([start, end]);
  });
  return ranges;
}

function isValidRanges(text) {
  const t = String(text || '').trim();
  if (!t) return true; // vide = fermé, c'est valide
  const parts = t.split(/[,;]/).filter((p) => p.trim());
  return parseRanges(t).length === parts.length;
}

// ------------------------------------------------------------
// Fuseau horaire (sans librairie) : décalage de Paris par rapport à UTC
// à un instant donné (+60 min l'hiver, +120 min l'été).
// ------------------------------------------------------------
function tzOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - date.getTime()) / 60000);
}

// "2026-10-04" + 630 (minutes, soit 10h30) heure de Paris → Date (instant réel).
function parisToDate(dateStr, minutes) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const off1 = tzOffsetMinutes(new Date(guess));
  let result = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(result));
  if (off2 !== off1) result = guess - off2 * 60000; // jour de changement d'heure
  return new Date(result);
}

// Date (instant) → { dateStr: "2026-10-04", weekday: 6, minutes: 630 } en heure de Paris.
function dateToParis(date) {
  const shifted = new Date(date.getTime() + tzOffsetMinutes(date) * 60000);
  return {
    dateStr: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function minutesToHHMM(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

function hhmmToMinutes(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v < 24 * 60 ? v : null;
}

// Libellé français : "samedi 4 octobre à 10h30".
function formatSlotLabel(date) {
  const day = date.toLocaleDateString('fr-FR', { timeZone: TIMEZONE, weekday: 'long', day: 'numeric', month: 'long' });
  const p = dateToParis(date);
  const h = Math.floor(p.minutes / 60);
  const mm = p.minutes % 60;
  return `${day} à ${h}h${mm ? String(mm).padStart(2, '0') : ''}`;
}

// ------------------------------------------------------------
// Créneaux libres d'une journée pour une prestation.
// existing = rendez-vous déjà pris ce jour-là : [{ start: Date, end: Date }]
// Un créneau est libre si le nombre de rendez-vous qui le chevauchent est
// inférieur à la capacité (nombre de coiffeurs, de tables…).
// ------------------------------------------------------------
function slotsForDay(config, dateStr, durationMin, existing, now = new Date()) {
  const todayParis = dateToParis(now).dateStr;
  if (dateStr < todayParis || dateStr > addDays(todayParis, config.maxDaysAhead)) return [];

  const ranges = parseRanges(config.hours[weekdayOf(dateStr)]);
  const earliest = now.getTime() + config.minNoticeHours * 3600000;
  const slots = [];

  ranges.forEach(([rangeStart, rangeEnd]) => {
    for (let t = rangeStart; t + durationMin <= rangeEnd; t += config.slotStep) {
      const start = parisToDate(dateStr, t);
      const end = new Date(start.getTime() + durationMin * 60000);
      if (start.getTime() < earliest) continue;
      const overlapping = existing.filter((b) => b.start < end && b.end > start).length;
      if (overlapping < config.capacity) slots.push({ time: minutesToHHMM(t), start, end });
    }
  });
  return slots;
}

module.exports = {
  TIMEZONE,
  WEEKDAYS,
  defaultBooking,
  parseBooking,
  sanitizeBooking,
  parseRanges,
  isValidRanges,
  parisToDate,
  dateToParis,
  addDays,
  weekdayOf,
  hhmmToMinutes,
  minutesToHHMM,
  formatSlotLabel,
  slotsForDay,
};
