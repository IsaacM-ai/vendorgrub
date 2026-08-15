import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { Flame, Star, Clock, Plus, Minus, ShoppingCart, MapPin, Phone, Instagram, Facebook, X, LayoutDashboard, ArrowLeft, ArrowRight, Truck, Store, CheckCircle2, Circle, EyeOff, Eye, MessageCircle, Send, Trash2, LogIn, LogOut, ChevronDown, ChevronLeft, ChevronRight, Palette, Image as ImageIcon, Lock } from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

// Vite doesn't resolve Leaflet's default marker image paths, so without
// this the default pin silently fails to render (a well-known Leaflet +
// bundler gotcha, not specific to this app).
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

/* =========================================================================
   LIVE BACKEND CONNECTION
   This app is now truck-agnostic — it reads which truck to show from the
   URL path (see PATH_SLUG below) and pulls everything else live from
   Supabase. One deployment serves every truck.
   ========================================================================= */
const SUPABASE_URL = "https://waylzndjvacmtnvrbwbx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndheWx6bmRqdmFjbXRudnJid2J4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNDgzOTYsImV4cCI6MjEwMDgyNDM5Nn0.X0C6yxcwXQ630NL4VE11NUe1VcSq_Pim-GrXxTT6IG4";
// The slug comes from the URL path (yourdomain.com/los-papas, yourdomain.com/taco-time)
// instead of being hardcoded. One deployment now serves every truck — creating a new
// truck in the "All Trucks" panel makes it live at /{slug} immediately, no redeploy needed.
const PATH_PARTS = window.location.pathname.split("/").filter(Boolean);
const PATH_SLUG = PATH_PARTS[0] || null;
const PATH_SUB = PATH_PARTS[1] || null; // "manage" | "kitchen" | null (storefront)

const rest = (path, opts = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      Prefer: opts.prefer || "return=representation",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : { Authorization: `Bearer ${SUPABASE_ANON_KEY}` }),
      ...opts.headers,
    },
  });

const fn = (name, body, token) =>
  fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json());

// Persistent login — Supabase access tokens expire in ~1hr, so this stores
// the refresh token too and silently renews on load instead of forcing a
// re-login every time the page navigates (this site uses full page loads,
// not client-side routing, so every nav would otherwise wipe React state).
const SESSION_KEY = "vg_session";
const saveSession = (s) => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} };
const loadSessionRaw = () => { try { const r = localStorage.getItem(SESSION_KEY); return r ? JSON.parse(r) : null; } catch { return null; } };
const clearSession = () => { try { localStorage.removeItem(SESSION_KEY); } catch {} };

async function refreshAuthSession(refresh_token) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token }),
    });
    const json = await res.json();
    if (!res.ok) return null;
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + (json.expires_in || 3600) * 1000,
      email: json.user?.email,
      userId: json.user?.id,
    };
  } catch { return null; }
}

// Call once on mount wherever a session is needed. Returns a valid, fresh
// session (refreshing if the stored one is stale) or null.
async function restoreSession() {
  const s = loadSessionRaw();
  if (!s) return null;
  if (s.expires_at && Date.now() < s.expires_at - 60000) return s;
  const refreshed = await refreshAuthSession(s.refresh_token);
  if (refreshed) { saveSession(refreshed); return refreshed; }
  clearSession();
  return null;
}

// Supabase access tokens expire in ~1hr. The dashboard restores its session
// once on mount, so without these helpers every write silently starts
// failing after an hour and only a page refresh fixes it. These keep the
// token fresh for the lifetime of the page instead.
async function getFreshToken(fallbackToken) {
  const s = loadSessionRaw();
  if (!s?.refresh_token) return fallbackToken;
  if (s.expires_at && Date.now() < s.expires_at - 60000) return s.access_token || fallbackToken;
  const refreshed = await refreshAuthSession(s.refresh_token);
  if (!refreshed) return fallbackToken;
  saveSession(refreshed);
  return refreshed.access_token;
}

// Forces a refresh regardless of the stored expiry — for when the server
// rejected a token we believed was still good (clock skew, revoked session).
async function forceRefreshToken() {
  const s = loadSessionRaw();
  if (!s?.refresh_token) return null;
  const refreshed = await refreshAuthSession(s.refresh_token);
  if (!refreshed) return null;
  saveSession(refreshed);
  return refreshed.access_token;
}

// Authenticated PostgREST call that survives token expiry: refreshes up
// front when stale, and retries once if the server still says 401/403.
async function authedRest(path, opts = {}) {
  const token = await getFreshToken(opts.token);
  const res = await rest(path, { ...opts, token });
  if (res.status !== 401 && res.status !== 403) return res;
  const retryToken = await forceRefreshToken();
  if (!retryToken || retryToken === token) return res;
  return rest(path, { ...opts, token: retryToken });
}

// Same contract for Edge Function calls, which return parsed JSON rather
// than a Response, so expiry is detected from the error payload instead.
async function authedFn(name, body, token) {
  const fresh = await getFreshToken(token);
  const out = await fn(name, body, fresh);
  const looksUnauthorized = out?.error && /session|jwt|token|unauthor/i.test(String(out.error));
  if (!looksUnauthorized) return out;
  const retryToken = await forceRefreshToken();
  if (!retryToken || retryToken === fresh) return out;
  return fn(name, body, retryToken);
}

// Uploads a photo to Storage and returns its public URL. Path convention:
// trucks/{truck_id}/{menu|gallery|theme}/{filename}
async function uploadPhoto(file, path, token) {
  const doUpload = (t) => fetch(`${SUPABASE_URL}/storage/v1/object/truck-photos/${path}`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${t}`, "Content-Type": file.type, "x-upsert": "true" },
    body: file,
  });
  const fresh = await getFreshToken(token);
  let res = await doUpload(fresh);
  if (res.status === 401 || res.status === 403) {
    const retryToken = await forceRefreshToken();
    if (retryToken && retryToken !== fresh) res = await doUpload(retryToken);
  }
  if (!res.ok) throw new Error("Upload failed — try signing out and back in");
  return `${SUPABASE_URL}/storage/v1/object/public/truck-photos/${path}`;
}

const COLORS_FALLBACK = { bg: "#0E0B09", card: "#1A1512", gold: "#D4A537", red: "#C4281C", cream: "#F3E9D8", stone: "#8C8074", green: "#4CA466" };

// Truck name display fonts — owner picks one in the dashboard, storefront
// renders the hero name in it. Google Fonts query fragment shared by every
// place that needs to actually load these families.
const NAME_FONTS = {
  kaushan: { label: "Kaushan Script", family: "'Kaushan Script', cursive" },
  pacifico: { label: "Pacifico", family: "'Pacifico', cursive" },
  anton: { label: "Anton", family: "'Anton', sans-serif" },
  bebas: { label: "Bebas Neue", family: "'Bebas Neue', sans-serif" },
  marker: { label: "Permanent Marker", family: "'Permanent Marker', cursive" },
  elegance: { label: "Alex Brush", family: "'Alex Brush', cursive" },
};
const NAME_FONTS_GOOGLE_QUERY = "family=Kaushan+Script&family=Pacifico&family=Anton&family=Bebas+Neue&family=Permanent+Marker&family=Alex+Brush";

// Section-heading font — template-level (not owner-chosen like NAME_FONTS),
// so "Featured Menu", "Popular Items", etc. carry each template's identity
// instead of every truck reading Oswald regardless of its palette/mood.
const HEADING_FONTS = {
  oswald: { label: "Oswald", family: "'Oswald', sans-serif" },
  quicksand: { label: "Quicksand", family: "'Quicksand', sans-serif" },
  fredoka: { label: "Fredoka", family: "'Fredoka', sans-serif" },
  orbitron: { label: "Orbitron", family: "'Orbitron', sans-serif" },
  playfair: { label: "Playfair Display", family: "'Playfair Display', serif" },
};

// Template-level decorative pattern, used for the menu-photo placeholder and
// the footer divider strip. Same two-color formula as the old hardcoded
// checkerboard, just swappable so each template gets its own texture instead
// of every truck inheriting one diner-flag motif regardless of its vibe.
function decorationPattern(key, colorA, colorB) {
  if (key === "dots") return { backgroundImage: `radial-gradient(${colorA} 28%, transparent 30%)`, backgroundSize: "10px 10px" };
  if (key === "scallop") return { backgroundImage: `linear-gradient(135deg, ${colorA} 25%, transparent 25.5%), linear-gradient(225deg, ${colorA} 25%, transparent 25.5%)`, backgroundSize: "14px 14px" };
  if (key === "circuit") return { backgroundImage: `linear-gradient(${colorA}55 1px, transparent 1px), linear-gradient(90deg, ${colorA}55 1px, transparent 1px)`, backgroundSize: "18px 18px" };
  if (key === "floral") return { backgroundImage: `radial-gradient(${colorA}40 1.5px, transparent 2px)`, backgroundSize: "13px 13px" };
  return { backgroundImage: `repeating-conic-gradient(${colorA} 0% 25%, ${colorB} 0% 50%)`, backgroundSize: "16px 16px" }; // "checker" default
}

// Same decoration identity, expressed as a wash behind the hero headline for
// trucks that haven't uploaded a photo yet — so "no photo" still reads as
// that template's personality instead of an empty page.
function heroWashCss(key, accent, accent2) {
  if (key === "dots") return `radial-gradient(${accent}33 2px, transparent 2.5px) 0 0/22px 22px, radial-gradient(${accent}1A 2px, transparent 2.5px) 11px 11px/22px 22px`;
  if (key === "scallop") return `linear-gradient(115deg, ${accent}29 0%, transparent 45%), linear-gradient(245deg, ${accent}1F 0%, transparent 40%)`;
  if (key === "circuit") return `radial-gradient(circle at 20% 15%, ${accent}3D, transparent 55%), radial-gradient(circle at 85% 75%, ${(accent2 || accent)}3D, transparent 55%)`;
  if (key === "floral") return `radial-gradient(circle at 50% 35%, ${accent}26, transparent 60%)`;
  return `radial-gradient(circle at 30% 20%, ${accent}22, transparent 60%)`; // "checker" default — existing look
}

// Builds the full color set for a truck, deriving borders/nav-bg/muted-text
// from the theme's mode (dark/light) instead of those being hardcoded to
// Los Papas' original dark palette everywhere they're used.
function buildColors(themeRow) {
  const t = themeRow || {};
  const mode = t.mode || "dark";
  const isLight = mode === "light";
  return {
    bg: t.color_bg || COLORS_FALLBACK.bg,
    card: t.color_card || COLORS_FALLBACK.card,
    gold: t.color_gold || COLORS_FALLBACK.gold,
    red: t.color_red || COLORS_FALLBACK.red,
    cream: t.color_cream || COLORS_FALLBACK.cream,
    stone: t.color_stone || COLORS_FALLBACK.stone,
    accent2: t.color_accent2 || null,
    green: COLORS_FALLBACK.green,
    mode,
    border: isLight ? "#F3D9E2" : "#2A2420",
    borderStrong: isLight ? "#ECC2D2" : "#3A322C",
    footerMuted: isLight ? "#C9A3AE" : "#4A4038",
    navBg: isLight ? "#FDE9EF" : "#0A0807",
  };
}

function useReveal() {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { threshold: 0.15 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return [ref, visible];
}
function Reveal({ children, delay = 0 }) {
  const [ref, visible] = useReveal();
  return (
    <div ref={ref} style={{ opacity: visible ? 1 : 0, transform: visible ? "translateY(0px)" : "translateY(24px)", transition: `opacity 0.7s ease ${delay}ms, transform 0.7s ease ${delay}ms` }}>
      {children}
    </div>
  );
}
// Shrinks its own font size (never wraps, never truncates) so long text
// like the live location line always reads fully on narrow phone screens
// instead of getting cut off with "..." in portrait mode.
function FitText({ text, maxSize = 11, minSize = 7.5, style, className }) {
  const containerRef = useRef(null);
  const textRef = useRef(null);

  const fit = useCallback(() => {
    const container = containerRef.current;
    const textEl = textRef.current;
    if (!container || !textEl) return;
    let s = maxSize;
    textEl.style.fontSize = s + "px";
    while (textEl.scrollWidth > container.clientWidth && s > minSize) {
      s -= 0.5;
      textEl.style.fontSize = s + "px";
    }
  }, [maxSize, minSize]);

  useLayoutEffect(() => { fit(); }, [text, fit]);

  useEffect(() => {
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
    };
  }, [fit]);

  return (
    <div ref={containerRef} style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
      <span ref={textRef} className={className} style={{ ...style, whiteSpace: "nowrap", display: "inline-block" }}>{text}</span>
    </div>
  );
}

function SpiceDots({ level, c }) {
  return <span style={{ display: "inline-flex", gap: 2 }}>{[0, 1, 2].map((i) => <Flame key={i} size={12} color={i < level ? c.red : "#3A322C"} fill={i < level ? c.red : "none"} />)}</span>;
}

// Sci-fi HUD-style corner accents, the CSS-buildable read on the reference
// image's futuristic framing — four small absolutely-positioned L-shapes,
// no image assets, works over any background.
function CornerBrackets({ color, size = 22 }) {
  const corner = (pos) => ({
    position: "absolute", width: size, height: size, borderColor: color, opacity: 0.8,
    ...(pos === "tl" && { top: 10, left: 10, borderTop: "2px solid", borderLeft: "2px solid" }),
    ...(pos === "tr" && { top: 10, right: 10, borderTop: "2px solid", borderRight: "2px solid" }),
    ...(pos === "bl" && { bottom: 10, left: 10, borderBottom: "2px solid", borderLeft: "2px solid" }),
    ...(pos === "br" && { bottom: 10, right: 10, borderBottom: "2px solid", borderRight: "2px solid" }),
  });
  return (
    <>
      <span style={corner("tl")} /><span style={corner("tr")} />
      <span style={corner("bl")} /><span style={corner("br")} />
    </>
  );
}

// Boutique-patisserie corner flourish for Atelier — one small SVG vine+petal
// mirrored into all four corners via CSS transforms, same single-asset
// approach as CornerBrackets, just a curve instead of an L-shape.
function FloralCorners({ color }) {
  const Flourish = () => (
    <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
      <path d="M4 4 C 4 20, 20 4, 36 4" stroke={color} strokeWidth="1" opacity="0.55" />
      <circle cx="4" cy="4" r="2" fill={color} opacity="0.7" />
      <circle cx="15" cy="9" r="1.3" fill={color} opacity="0.5" />
      <circle cx="24" cy="5.5" r="1" fill={color} opacity="0.4" />
    </svg>
  );
  const corner = (pos) => ({
    position: "absolute", lineHeight: 0,
    ...(pos === "tl" && { top: 10, left: 10 }),
    ...(pos === "tr" && { top: 10, right: 10, transform: "scaleX(-1)" }),
    ...(pos === "bl" && { bottom: 10, left: 10, transform: "scaleY(-1)" }),
    ...(pos === "br" && { bottom: 10, right: 10, transform: "scale(-1,-1)" }),
  });
  return (
    <>
      <span style={corner("tl")}><Flourish /></span>
      <span style={corner("tr")}><Flourish /></span>
      <span style={corner("bl")}><Flourish /></span>
      <span style={corner("br")}><Flourish /></span>
    </>
  );
}

// Miniature, non-interactive replica of the real CustomerSite layout (nav,
// live-status strip, hero, menu cards) drawn as proportioned bars from a
// template row's own mode/menu_layout/colors — so the onboarding picker
// shows what the page looks like, not just what colors it uses, and can
// never drift from the fields that actually drive the real storefront.
function TemplateThumb({ t }) {
  const isLight = t.mode === "light";
  const navBg = isLight ? "#FDE9EF" : "#0A0807";
  const border = isLight ? "#F3D9E2" : "#2A2420";
  const isGrid = t.menu_layout === "grid";
  const cardCount = isGrid ? 2 : 3;

  const deco = decorationPattern(t.decoration, t.color_red, t.color_card);
  const MiniMenuCard = ({ i }) => (
    <div style={{ background: t.color_card, border: `1px solid ${border}`, borderRadius: 3, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, minHeight: 0, ...deco }} />
      <div style={{ padding: 3, flexShrink: 0 }}>
        <div style={{ height: 2, width: "80%", borderRadius: 1, background: t.color_stone, marginBottom: 2 }} />
        <div style={{ height: 2.5, width: "40%", borderRadius: 1, background: t.color_gold }} />
      </div>
    </div>
  );

  return (
    <div style={{ width: 84, height: 84, borderRadius: 9, overflow: "hidden", flexShrink: 0, background: t.color_bg, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 6px 3px", flexShrink: 0 }}>
        <span style={{ width: 26, height: 5, borderRadius: 2, background: t.color_gold, display: "block" }} />
        <span style={{ width: 12, height: 7, borderRadius: 4, background: t.color_gold, display: "block" }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 3, padding: "2px 6px", background: navBg, flexShrink: 0 }}>
        <span style={{ width: 3, height: 3, borderRadius: "50%", background: t.color_gold, flexShrink: 0, display: "block" }} />
        <span style={{ flex: 1, height: 2.5, borderRadius: 2, background: t.color_gold, opacity: 0.5, display: "block" }} />
      </div>
      <div style={{ padding: "7px 6px 4px", flexShrink: 0 }}>
        <span style={{ display: "block", width: "30%", height: 2.5, borderRadius: 2, background: t.color_gold, marginBottom: 4, opacity: 0.85 }} />
        <span style={{ display: "block", width: "62%", height: 8, borderRadius: 2, background: t.color_cream, marginBottom: 4 }} />
        <span style={{ display: "block", width: "45%", height: 2.5, borderRadius: 2, background: t.color_stone }} />
      </div>
      <span style={{ display: "block", width: "34%", height: 2.5, borderRadius: 2, background: t.color_gold, opacity: 0.85, margin: "5px 0 5px 6px", flexShrink: 0 }} />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: "0 6px 6px",
          display: "grid",
          gap: 4,
          ...(isGrid
            ? { gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr" }
            : { gridAutoFlow: "column", gridAutoColumns: "47%", overflow: "hidden" }),
        }}
      >
        {Array.from({ length: cardCount }).map((_, i) => <MiniMenuCard key={i} i={i} />)}
      </div>
    </div>
  );
}

// Mutually-exclusive Popular/Special-Deal picker for a menu item — one tag
// max per item, since a real owner is only ever spotlighting a best-seller
// OR running a promo on a given item, not both. Deal items get a short
// optional note (the actual "20% off" / "Buy 1 Get 1" detail) since a bare
// badge alone doesn't tell the customer what the deal is.
function PromoTagPicker({ c, item, onSetTag, onSetNote }) {
  const setTag = (tag) => onSetTag(item, item.promo_tag === tag ? null : tag);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          onClick={() => setTag("popular")}
          style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 4, background: item.promo_tag === "popular" ? `${c.gold}22` : "none", border: `1px solid ${item.promo_tag === "popular" ? c.gold : "#2A2420"}`, color: item.promo_tag === "popular" ? c.gold : c.stone, borderRadius: 999, padding: "5px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
        >
          <Star size={11} /> POPULAR
        </button>
        <button
          onClick={() => setTag("deal")}
          style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 4, background: item.promo_tag === "deal" ? `${c.red}22` : "none", border: `1px solid ${item.promo_tag === "deal" ? c.red : "#2A2420"}`, color: item.promo_tag === "deal" ? c.red : c.stone, borderRadius: 999, padding: "5px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
        >
          <Flame size={11} /> SPECIAL DEAL
        </button>
      </div>
      {item.promo_tag === "deal" && (
        <input
          defaultValue={item.promo_note || ""}
          onBlur={(e) => onSetNote(item, e.target.value)}
          placeholder="Deal details — e.g. 20% off today, Buy 1 Get 1"
          style={{ width: "100%", background: c.bg, border: "1px solid #2A2420", borderRadius: 6, padding: "6px 8px", color: c.cream, fontSize: 11, marginTop: 6 }}
        />
      )}
    </div>
  );
}

// Assigns a menu item to one of the truck's 5 fixed categories — only shown
// for templates with category browsing (currently Atelier only).
function CategoryPicker({ c, item, categories, onSetCategory }) {
  return (
    <select
      value={item.category_id || ""}
      onChange={(e) => onSetCategory(item, e.target.value || null)}
      style={{ width: "100%", background: c.bg, border: "1px solid #2A2420", borderRadius: 6, padding: "6px 8px", color: c.cream, fontSize: 11, marginTop: 8 }}
    >
      <option value="">No category</option>
      {categories.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
    </select>
  );
}

// Lets the owner rename categories, add a caption, add new categories, and
// delete ones they don't need. Every truck already has 5 categories seeded
// at signup (previously only usable on one template) -- this now works the
// same way for everyone, and powers both Take Order's category filter and
// the customer site's category pills.
function MenuCategoriesPanel({ c, categories, onSave, onAdd, onDelete }) {
  const [drafts, setDrafts] = useState(() => Object.fromEntries(categories.map((cat) => [cat.id, { name: cat.name, caption: cat.caption || "" }])));
  const [savedId, setSavedId] = useState("");
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  const addCategory = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try { await onAdd(newName.trim()); setNewName(""); } finally { setAdding(false); }
  };

  return (
    <div style={{ background: c.card, border: "1px solid #2A2420", borderRadius: 12, padding: 14, marginBottom: 14 }}>
      <p style={{ fontSize: 11.5, color: c.stone, marginBottom: 12, lineHeight: 1.5 }}>Group your menu into categories — customers can browse by category on your site, and you can filter by category when taking a counter order.</p>
      {categories.map((cat) => (
        <div key={cat.id} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid #2A2420" }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input
              value={drafts[cat.id]?.name ?? cat.name}
              onChange={(e) => setDrafts((d) => ({ ...d, [cat.id]: { ...d[cat.id], name: e.target.value } }))}
              style={{ flex: 1, background: c.bg, border: "1px solid #2A2420", borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, fontWeight: 700 }}
            />
            <button onClick={() => onDelete(cat.id)} style={{ background: "none", border: "none", color: c.stone, cursor: "pointer", flexShrink: 0 }}><Trash2 size={14} /></button>
          </div>
          <input
            value={drafts[cat.id]?.caption ?? (cat.caption || "")}
            onChange={(e) => setDrafts((d) => ({ ...d, [cat.id]: { ...d[cat.id], caption: e.target.value } }))}
            placeholder="Optional caption shown to customers…"
            style={{ width: "100%", background: c.bg, border: "1px solid #2A2420", borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 11, marginBottom: 6 }}
          />
          <button
            onClick={async () => { await onSave(cat.id, drafts[cat.id]); setSavedId(cat.id); setTimeout(() => setSavedId(""), 1500); }}
            style={{ background: "none", border: `1px solid ${c.gold}`, color: c.gold, borderRadius: 6, padding: "4px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
          >
            {savedId === cat.id ? "Saved" : "Save"}
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={newName} onChange={(e) => setNewName(e.target.value)}
          placeholder="New category name…"
          style={{ flex: 1, background: c.bg, border: "1px dashed #3A322C", borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12 }}
        />
        <button
          onClick={addCategory} disabled={adding || !newName.trim()}
          style={{ background: c.gold, color: "#1A1210", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", opacity: (adding || !newName.trim()) ? 0.6 : 1, flexShrink: 0 }}
        >
          + Add
        </button>
      </div>
    </div>
  );
}

// Click-to-drop-a-pin location picker for the owner dashboard — no address
// typing, no geocoding service, no API key. Falls back to a Corpus Christi
// view (where VendorGrub is based) until the owner has set a pin.
const NO_PIN_CENTER = [27.8006, -97.3964];
function LocationClickHandler({ onPick }) {
  useMapEvents({ click(e) { onPick(e.latlng.lat, e.latlng.lng); } });
  return null;
}
// Leaflet measures its container on mount; inside a dashboard panel that is
// still settling (or a tab that was hidden) it can come up blank until
// something forces a re-measure.
function InvalidateOnMount() {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 120);
    return () => clearTimeout(t);
  }, [map]);
  return null;
}

function LocationPinPicker({ lat, lng, onPick, onClear, c }) {
  const hasPin = lat != null && lng != null;
  const muted = c?.stone || "#8C8074";
  const good = c?.green || "#4CA466";
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ height: 200, borderRadius: 10, overflow: "hidden" }}>
        <MapContainer center={hasPin ? [lat, lng] : NO_PIN_CENTER} zoom={hasPin ? 14 : 11} style={{ height: "100%", width: "100%" }}>
          <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          {hasPin && <Marker position={[lat, lng]} />}
          <LocationClickHandler onPick={onPick} />
          <InvalidateOnMount />
        </MapContainer>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
        {hasPin ? (
          <>
            <span style={{ fontSize: 10.5, color: good, fontWeight: 700, flex: 1 }}>
              ✓ Pin set — customers see a map on your site.{" "}
              <span className="mono" style={{ color: muted, fontWeight: 400 }}>{Number(lat).toFixed(4)}, {Number(lng).toFixed(4)}</span>
            </span>
            {onClear && (
              <button onClick={onClear} style={{ background: "none", border: "none", color: muted, fontSize: 10, textDecoration: "underline", cursor: "pointer", flexShrink: 0 }}>Remove pin</button>
            )}
          </>
        ) : (
          <span style={{ fontSize: 10.5, color: muted }}>Tap the map to drop a pin where you're parked, then press Update Location to save it.</span>
        )}
      </div>
    </div>
  );
}

/* Loads everything needed to render the storefront + feed the chatbot, live from Supabase */
function useTruckData() {
  const [state, setState] = useState({ loading: true, error: null, truck: null, theme: null, menu: [], location: null, faqs: [], gallery: [], loyalty: null, categories: [] });

  const reload = useCallback(async () => {
    if (!PATH_SLUG) { setState((s) => ({ ...s, loading: false, error: null, truck: null })); return; }
    try {
      const truckRes = await rest(`trucks?slug=eq.${PATH_SLUG}&select=id,slug,name,tagline,subline,phone,delivery_radius,delivery_fee,rating,review_count,is_active,is_listed,about_text`).then((r) => r.json());
      const truck = truckRes?.[0];
      if (!truck) throw new Error("Truck not found");

      // Scoped by truck_id in the query itself — each truck's data is fetched
      // independently, never pulled alongside other trucks' rows.
      const [themeRes, menuRes, locRes, faqRes, galRes, loyaltyRes, catRes] = await Promise.all([
        rest(`truck_theme?truck_id=eq.${truck.id}&select=*`).then((r) => r.json()),
        rest(`menu_items?truck_id=eq.${truck.id}&select=*&order=sort_order`).then((r) => r.json()),
        rest(`truck_location?truck_id=eq.${truck.id}&select=*`).then((r) => r.json()),
        rest(`faqs?truck_id=eq.${truck.id}&select=*`).then((r) => r.json()),
        rest(`gallery_photos?truck_id=eq.${truck.id}&select=*&order=sort_order`).then((r) => r.json()),
        rest(`loyalty_settings?truck_id=eq.${truck.id}&select=*`).then((r) => r.json()),
        rest(`menu_categories?truck_id=eq.${truck.id}&select=*&order=sort_order`).then((r) => r.json()),
      ]);
      setState({
        loading: false,
        error: null,
        truck,
        theme: themeRes?.[0] || null,
        menu: menuRes || [],
        location: locRes?.[0] || null,
        faqs: faqRes || [],
        gallery: galRes || [],
        loyalty: loyaltyRes?.[0] || null,
        categories: catRes || [],
      });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }));
    }
  }, []);

  // Orders require an authenticated (admin/owner) request — fetched separately
  // by the dashboard once a session exists, not on public page load.
  const loadOrders = useCallback(async (truckId, token) => {
    const res = await authedRest(`orders?truck_id=eq.${truckId}&order=created_at.desc`, { token });
    return res.ok ? res.json() : [];
  }, []);

  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload, loadOrders };
}

/* ============================= SELF-ONBOARDING (new owner signs themselves up) ============================= */
function SelfOnboard() {
  const b = BRAND;
  const [step, setStep] = useState(1);
  const [templates, setTemplates] = useState(null);
  const [form, setForm] = useState({ email: "", password: "", truck_name: "", slug: "", phone: "", template_key: "", agreed_terms: false });
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugStatus, setSlugStatus] = useState(null); // null | 'checking' | 'available' | 'taken'
  const [slugSuggestions, setSlugSuggestions] = useState([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(null);
  const slugCheckTimer = useRef(null);

  useEffect(() => {
    rest(`site_templates?select=*&order=sort_order`).then((r) => r.json()).then((rows) => {
      setTemplates(rows);
      if (rows?.[0]) setForm((s) => ({ ...s, template_key: rows[0].key }));
    });
  }, []);

  const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]/g, "");

  const checkSlug = useCallback((slug) => {
    clearTimeout(slugCheckTimer.current);
    if (!slug) { setSlugStatus(null); return; }
    setSlugStatus("checking");
    slugCheckTimer.current = setTimeout(async () => {
      const res = await fn("check-slug", { slug });
      if (res.available) {
        setSlugStatus("available");
        setSlugSuggestions([]);
      } else {
        setSlugStatus("taken");
        setSlugSuggestions([`${slug}tx`, `${slug}cc`, `${slug}truck`]);
      }
    }, 450);
  }, []);

  const onTruckName = (val) => {
    setForm((s) => {
      const next = { ...s, truck_name: val };
      if (!slugTouched) next.slug = slugify(val);
      return next;
    });
    if (!slugTouched) checkSlug(slugify(val));
  };

  const onSlugEdit = (val) => {
    const clean = slugify(val);
    setSlugTouched(true);
    setForm((s) => ({ ...s, slug: clean }));
    checkSlug(clean);
  };

  const step1Valid = form.email && form.password.length >= 8 && form.truck_name && form.slug && slugStatus === "available";

  const submit = async () => {
    setError("");
    setSubmitting(true);
    const res = await fn("self-onboard", form);
    if (res.error) { setSubmitting(false); setError(res.error); return; }

    // Log them straight in so "Go to Dashboard" on the next screen doesn't
    // ask for the password they just typed 10 seconds ago.
    try {
      const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email: form.email, password: form.password }),
      });
      const json = await loginRes.json();
      if (loginRes.ok) {
        saveSession({ access_token: json.access_token, refresh_token: json.refresh_token, expires_at: Date.now() + (json.expires_in || 3600) * 1000, email: form.email, userId: json.user?.id });
      }
    } catch {}

    setSubmitting(false);
    setSuccess(res.slug);
  };

  const siteUrl = `${form.slug || "yourtruck"}.vendorgrub.netlify.app`; // display text only — real link below is unchanged
  const fullUrl = `https://vendorgrub.netlify.app/${success}`;

  const downloadQR = () => {
    const canvas = document.getElementById("signup-qr");
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `${success}-qr-code.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };
  const copyLink = () => navigator.clipboard.writeText(fullUrl);

  if (success) {
    return (
      <div style={{ background: b.bg, color: b.white, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Manrope', system-ui, sans-serif", padding: 24, textAlign: "center" }}>
        <div style={{ width: "100%", maxWidth: 320 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
          <h2 className="vg-display" style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Your VendorGrub site is created!</h2>
          <p style={{ color: b.stone, fontSize: 13, marginBottom: 20 }}>{form.truck_name}</p>

          <div style={{ background: "#fff", borderRadius: 16, padding: 20, display: "inline-block", marginBottom: 16 }}>
            <QRCodeCanvas id="signup-qr" value={fullUrl} size={180} fgColor="#0A0A0A" bgColor="#ffffff" />
          </div>
          <p className="vg-mono" style={{ fontSize: 11, color: b.teal, marginBottom: 4 }}>{siteUrl}</p>
          <p style={{ color: b.stone, fontSize: 12.5, lineHeight: 1.5, marginBottom: 20 }}>Your page is ready. Let's add your menu, location, and truck details before customers start ordering.</p>

          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button onClick={downloadQR} style={{ flex: 1, background: b.card, border: `1px solid ${b.border}`, color: b.white, padding: "12px", borderRadius: 10, fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Download QR</button>
            <button onClick={copyLink} style={{ flex: 1, background: b.card, border: `1px solid ${b.border}`, color: b.white, padding: "12px", borderRadius: 10, fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Copy Link</button>
          </div>
          <a href={`/${success}/manage`} style={{ display: "block", background: b.teal, color: "#0A0A0A", padding: "13px", borderRadius: 10, fontWeight: 700, fontSize: 14, textDecoration: "none", marginBottom: 10 }}>Finish My Setup →</a>
          <a href={`/${success}/manage`} style={{ display: "block", color: b.stone, fontSize: 12, textDecoration: "underline", marginBottom: 10 }}>I'll Do This Later</a>
          <a href={`/${success}`} style={{ display: "block", color: b.stone, fontSize: 12, textDecoration: "underline" }}>View My Website</a>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: b.bg, color: b.white, minHeight: "100vh", fontFamily: "'Manrope', system-ui, sans-serif", padding: 24 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@600&display=swap');
        .vg-display { font-family: 'Space Grotesk', sans-serif; } .vg-mono { font-family: 'JetBrains Mono', monospace; }
      `}</style>
      <div style={{ maxWidth: 400, margin: "0 auto" }}>
        <h1 className="vg-display" style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>🚚 Create Your Truck's Ordering Page</h1>
        <p style={{ fontSize: 12, color: b.stone, marginBottom: 14 }}>Let's get your food truck online in less than 60 seconds.</p>

        <div style={{ fontSize: 11, color: b.stone, marginBottom: 4 }}>Step {step} of 2</div>
        <div style={{ background: b.card, borderRadius: 999, height: 6, marginBottom: 20, overflow: "hidden" }}>
          <div style={{ background: b.teal, height: "100%", width: step === 1 ? "50%" : "100%", transition: "width 0.3s ease" }} />
        </div>

        {/* Live preview card — updates as they type */}
        <div style={{ background: b.card, border: `1px solid ${b.border}`, borderRadius: 14, padding: 16, marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>🚚 {form.truck_name || "Your Truck"}</span>
            <span className="vg-mono" style={{ fontSize: 9, color: b.stone, border: `1px solid ${b.border}`, borderRadius: 999, padding: "2px 8px" }}>NOT LIVE YET</span>
          </div>
          <p className="vg-mono" style={{ fontSize: 12, color: b.teal, marginBottom: 8 }}>{form.slug || "yourtruck"}.vendorgrub.netlify.app</p>
          <p style={{ fontSize: 11, color: b.stone }}>✓ QR code will be generated automatically</p>
        </div>

        {step === 1 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 700, color: b.teal, letterSpacing: 1, marginBottom: 8 }}>ACCOUNT</div>
            <label style={{ fontSize: 12, color: b.stone, display: "block", marginBottom: 4 }}>Email</label>
            <input value={form.email} onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))} type="email" style={{ width: "100%", background: "rgba(47,191,212,0.07)", border: `1.5px solid ${b.teal}99`, backdropFilter: "blur(6px)", borderRadius: 999, padding: "11px 12px", color: b.white, marginBottom: 12, fontSize: 14 }} />
            <label style={{ fontSize: 12, color: b.stone, display: "block", marginBottom: 4 }}>Password (min 8 characters)</label>
            <input value={form.password} onChange={(e) => setForm((s) => ({ ...s, password: e.target.value }))} type="password" style={{ width: "100%", background: "rgba(47,191,212,0.07)", border: `1.5px solid ${b.teal}99`, backdropFilter: "blur(6px)", borderRadius: 999, padding: "11px 12px", color: b.white, marginBottom: 22, fontSize: 14 }} />

            <div style={{ fontSize: 11, fontWeight: 700, color: b.teal, letterSpacing: 1, marginBottom: 8 }}>TRUCK DETAILS</div>
            <label style={{ fontSize: 12, color: b.stone, display: "block", marginBottom: 4 }}>What is your food truck called?</label>
            <input value={form.truck_name} onChange={(e) => onTruckName(e.target.value)} placeholder="Los Papas" style={{ width: "100%", background: "rgba(47,191,212,0.07)", border: `1.5px solid ${b.teal}99`, backdropFilter: "blur(6px)", borderRadius: 999, padding: "11px 12px", color: b.white, marginBottom: 12, fontSize: 14 }} />

            <label style={{ fontSize: 12, color: b.stone, display: "block", marginBottom: 4 }}>Choose your page name</label>
            <div style={{ display: "flex", alignItems: "center", background: "rgba(47,191,212,0.07)", backdropFilter: "blur(6px)", border: `1.5px solid ${slugStatus === "taken" ? "#E5484D" : slugStatus === "available" ? "#4CA466" : `${b.teal}99`}`, borderRadius: 999, padding: "0 16px", marginBottom: 4 }}>
              <input value={form.slug} onChange={(e) => onSlugEdit(e.target.value)} placeholder="lospapas" style={{ flex: 1, minWidth: 0, background: "none", border: "none", color: b.white, padding: "11px 0", fontSize: 13, outline: "none" }} />
              <span className="vg-mono" style={{ fontSize: 12, color: b.stone, whiteSpace: "nowrap" }}>.vendorgrub.netlify.app</span>
            </div>
            <div style={{ marginBottom: 12, minHeight: 16 }}>
              {slugStatus === "checking" && <span style={{ fontSize: 11, color: b.stone }}>Checking…</span>}
              {slugStatus === "available" && <span style={{ fontSize: 11, color: "#4CA466" }}>✓ Available</span>}
              {slugStatus === "taken" && (
                <div>
                  <span style={{ fontSize: 11, color: "#E5484D" }}>⚠ Already taken — try:</span>
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    {slugSuggestions.map((s) => (
                      <button key={s} onClick={() => onSlugEdit(s)} className="vg-mono" style={{ fontSize: 10, background: "none", border: `1px solid ${b.border}`, color: b.teal, borderRadius: 999, padding: "4px 10px", cursor: "pointer" }}>{s}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <label style={{ fontSize: 12, color: b.stone, display: "block", marginBottom: 4 }}>Business Phone</label>
            <input value={form.phone} onChange={(e) => setForm((s) => ({ ...s, phone: e.target.value }))} placeholder="(361) 555-1234" style={{ width: "100%", background: "rgba(47,191,212,0.07)", border: `1.5px solid ${b.teal}99`, backdropFilter: "blur(6px)", borderRadius: 999, padding: "11px 12px", color: b.white, marginBottom: 20, fontSize: 14 }} />

            <button
              disabled={!step1Valid}
              onClick={() => setStep(2)}
              style={{ width: "100%", background: b.teal, color: "#0A0A0A", border: "none", padding: "14px", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: step1Valid ? 1 : 0.5 }}
            >
              Continue → Step 2: Pick a Design
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <p style={{ fontSize: 13, color: b.stone, marginBottom: 14 }}>Pick a look. Every design has the same features underneath — ordering, live location, chatbot, FAQs.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
              {templates?.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setForm((s) => ({ ...s, template_key: t.key }))}
                  style={{ display: "grid", gridTemplateColumns: "84px 1fr", gap: 12, alignItems: "center", textAlign: "left", background: form.template_key === t.key ? "rgba(47,191,212,0.1)" : b.card, border: `2px solid ${form.template_key === t.key ? b.teal : b.border}`, borderRadius: 12, padding: 10, cursor: "pointer" }}
                >
                  <TemplateThumb t={t} />
                  <div>
                    <div style={{ color: b.white, fontWeight: 700, fontSize: 14 }}>{t.name}</div>
                    <div style={{ color: b.stone, fontSize: 11, marginTop: 2 }}>{t.description}</div>
                  </div>
                </button>
              ))}
              {[1, 2].map((n) => (
                <div key={n} style={{ display: "grid", gridTemplateColumns: "84px 1fr", gap: 12, alignItems: "center", background: b.card, border: `2px dashed ${b.border}`, borderRadius: 12, padding: 10, opacity: 0.5, position: "relative" }}>
                  <div style={{ width: 84, height: 84, borderRadius: 9, background: "#1C1C1C", border: `1px solid ${b.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <ImageIcon size={22} color={b.stone} />
                  </div>
                  <div style={{ color: b.stone, fontWeight: 700, fontSize: 14 }}>Design {(templates?.length || 0) + n}</div>
                  <span className="vg-mono" style={{ position: "absolute", top: 10, right: 10, fontSize: 9, color: b.teal, border: `1px solid ${b.teal}`, borderRadius: 999, padding: "3px 8px", background: b.bg }}>COMING SOON</span>
                </div>
              ))}
            </div>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={form.agreed_terms} onChange={(e) => setForm((s) => ({ ...s, agreed_terms: e.target.checked }))} style={{ marginTop: 2 }} />
              <span style={{ fontSize: 12, color: b.stone, lineHeight: 1.4 }}>
                I agree to the <a href="/terms" target="_blank" rel="noreferrer" style={{ color: b.teal }}>Terms of Service</a>, including that I hold all required licenses and permits and am solely responsible for my food and business.
              </span>
            </label>
            {error && <p style={{ color: "#E5484D", fontSize: 12, marginBottom: 12 }}>{error}</p>}
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setStep(1)} style={{ flex: 1, background: "none", border: `1px solid ${b.border}`, color: b.stone, padding: "13px", borderRadius: 10, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>← Back</button>
              <button onClick={submit} disabled={submitting || !form.agreed_terms} style={{ flex: 2, background: b.teal, color: "#0A0A0A", border: "none", padding: "13px", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: (submitting || !form.agreed_terms) ? 0.6 : 1 }}>
                {submitting ? "Creating your site…" : "Create My Site"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ============================= LANDING PAGE (root domain — the actual "door") ============================= */
const BRAND = { bg: "#0A0A0A", card: "#161616", teal: "#2FBFD4", white: "#F5F5F5", stone: "#8B8B8B", border: "#262626" };

function LandingPage() {
  const b = BRAND;
  const [mounted, setMounted] = useState(false);
  useEffect(() => { const t = setTimeout(() => setMounted(true), 30); return () => clearTimeout(t); }, []);

  const features = [
    { title: "Online Ordering", desc: "Customers browse your menu, order, and choose pickup or delivery — no phone tag." },
    { title: "Live Location", desc: "One tap updates where you're parked. Customers always know where to find you." },
    { title: "Chatbot", desc: "Answers customer questions from your own FAQs, any time of day." },
    { title: "Your Dashboard", desc: "Menu, photos, orders, and FAQs — all editable by you, live, anytime." },
  ];

  const fadeUp = (delay) => ({
    opacity: mounted ? 1 : 0,
    transform: mounted ? "translateY(0)" : "translateY(14px)",
    transition: `opacity 0.6s ease ${delay}ms, transform 0.6s ease ${delay}ms`,
  });

  return (
    <div style={{ background: b.bg, color: b.white, minHeight: "100vh", fontFamily: "'Manrope', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@600&display=swap');
        .vg-display { font-family: 'Space Grotesk', sans-serif; }
        .vg-mono { font-family: 'JetBrains Mono', monospace; }
      `}</style>

      <nav style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "18px 20px" }}>
        <a href="/trucks" style={{ fontSize: 12, color: b.stone, textDecoration: "none", marginRight: 18 }}>See live trucks</a>
        <a href="/login" style={{ fontSize: 12, color: b.white, textDecoration: "none", fontWeight: 600 }}>Owner Login</a>
      </nav>

      <section style={{ padding: "18px 20px 40px", textAlign: "center" }}>
        <div style={fadeUp(0)}>
          <img src="/vendorgrub-logo.png" alt="VendorGrub" style={{ height: 88, margin: "0 auto 28px", display: "block" }} />
        </div>

        <div style={{ maxWidth: 420, margin: "0 auto" }}>
          <div style={fadeUp(80)}>
            <span className="vg-mono" style={{ display: "inline-block", background: `${b.teal}1A`, color: b.teal, fontSize: 11, fontWeight: 600, padding: "7px 14px", borderRadius: 999, marginBottom: 20 }}>
              A WEBSITE &amp; ORDERING TOOL FOR FOOD TRUCKS
            </span>
          </div>
          <h1 className="vg-display" style={{ fontSize: 34, fontWeight: 700, lineHeight: 1.2, marginBottom: 16, ...fadeUp(140) }}>
            Your truck. <span style={{ color: b.teal }}>Your site.</span><br />Your way.
          </h1>
          <p style={{ fontSize: 15, color: "#B8B8B8", marginBottom: 28, lineHeight: 1.6, ...fadeUp(200) }}>
            Take orders, share your live location, and answer customer questions automatically — from one page you fully control. You run the truck; we're just the tool.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, ...fadeUp(260) }}>
            <a href="/start" style={{ background: b.teal, color: "#0A0A0A", textAlign: "center", padding: "15px", borderRadius: 10, fontWeight: 700, fontSize: 14, textDecoration: "none" }}>
              Create Your Truck's Site — Free
            </a>
            <a href="/demo" style={{ border: `1px solid ${b.border}`, color: b.white, textAlign: "center", padding: "15px", borderRadius: 10, fontWeight: 600, fontSize: 14, textDecoration: "none" }}>
              ▶ View Live Demo
            </a>
            <a href="/login" style={{ fontSize: 12, color: b.stone, marginTop: 6 }}>
              Already have an account? <span style={{ color: b.teal, fontWeight: 600 }}>Log in</span>
            </a>
          </div>
        </div>
      </section>

      <section style={{ padding: "8px 20px 40px" }}>
        <h2 className="vg-display" style={{ fontSize: 19, fontWeight: 700, marginBottom: 14, textAlign: "center" }}>Everything you need. <span style={{ color: b.teal }}>All in one place.</span></h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {features.map((f) => (
            <div key={f.title} style={{ background: b.card, border: `1px solid ${b.border}`, borderRadius: 12, padding: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: b.white, marginBottom: 6 }}>{f.title}</div>
              <div style={{ fontSize: 12, color: b.stone, lineHeight: 1.4 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ padding: "0 20px 40px" }}>
        <div style={{ background: b.card, border: `1px solid ${b.border}`, borderRadius: 14, padding: 24, textAlign: "center" }}>
          <p style={{ fontSize: 13, color: b.stone, marginBottom: 16, lineHeight: 1.5 }}>
            No design skills, no code, nothing to maintain yourself. Pick a look, add your menu, and your site is ready the same day.
          </p>
          <a href="/start" style={{ background: b.teal, color: "#0A0A0A", padding: "13px 26px", borderRadius: 10, fontWeight: 700, fontSize: 13, textDecoration: "none", display: "inline-block", marginBottom: 12 }}>
            Get Started →
          </a>
          <a href="/login" style={{ display: "block", fontSize: 12, color: b.stone }}>
            Already have an account? <span style={{ color: b.teal, fontWeight: 600 }}>Log in</span>
          </a>
        </div>
      </section>

      <footer style={{ padding: "20px", borderTop: `1px solid ${b.border}`, textAlign: "center" }}>
        <p style={{ fontSize: 11, color: "#4A4A4A" }}>© {new Date().getFullYear()} VendorGrub. Built in Corpus Christi.</p>
      </footer>
    </div>
  );
}

/* ============================= KITCHEN DASHBOARD (PIN-gated, no login) ============================= */
/* ============================= REWARDS CHECK (public — /{slug}/rewards, no login) ============================= */
// Landed on from the unsubscribe link at the bottom of every marketing
// email -- reads the email straight off the query string (the link is
// generated server-side per recipient, never typed by hand) and confirms
// the opt-out immediately, no login or extra click required.
function UnsubscribePage({ slug }) {
  const c = COLORS_FALLBACK;
  const [status, setStatus] = useState("working"); // 'working' | 'done' | 'error'
  const [error, setError] = useState("");

  useEffect(() => {
    const email = new URLSearchParams(window.location.search).get("email");
    if (!email) { setStatus("error"); setError("Missing email address."); return; }
    fn("unsubscribe", { slug, email }).then((res) => {
      if (res.error) { setStatus("error"); setError(res.error); return; }
      setStatus("done");
    });
  }, [slug]);

  return (
    <div style={{ background: c.bg, color: c.cream, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui", padding: 24, textAlign: "center" }}>
      <div style={{ maxWidth: 340 }}>
        {status === "working" && <p style={{ color: c.stone }}>Unsubscribing…</p>}
        {status === "done" && (
          <>
            <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
            <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>You're unsubscribed</h1>
            <p style={{ color: c.stone, fontSize: 13 }}>You won't get any more marketing emails from this truck.</p>
          </>
        )}
        {status === "error" && <p style={{ color: c.red, fontSize: 13 }}>{error || "Something went wrong."}</p>}
      </div>
    </div>
  );
}

function RewardsCheck({ slug }) {
  const c = COLORS_FALLBACK;
  const [phone, setPhone] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const check = async () => {
    if (!phone.trim()) return;
    setLoading(true);
    setError("");
    const res = await fn("check-loyalty", { slug, phone: phone.trim() });
    setLoading(false);
    if (res.error) { setError(res.error); return; }
    setResult(res);
  };

  return (
    <div style={{ background: c.bg, color: c.cream, minHeight: "100vh", fontFamily: "system-ui", padding: 24 }}>
      <div style={{ maxWidth: 360, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>🎁 {result?.truck_name || "Rewards"}</h1>
        <p style={{ fontSize: 12, color: c.stone, marginBottom: 20 }}>Enter your phone number to check your points.</p>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(361) 555-1234" type="tel" style={{ flex: 1, background: c.card, border: "1px solid #2A2420", borderRadius: 10, padding: "12px 14px", color: c.cream, fontSize: 14 }} />
          <button onClick={check} disabled={loading} style={{ background: c.gold, color: "#1A1210", border: "none", borderRadius: 10, padding: "0 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>{loading ? "…" : "Check"}</button>
        </div>
        {error && <p style={{ color: c.red, fontSize: 12, marginBottom: 12 }}>{error}</p>}

        {result && (
          <div style={{ marginTop: 20 }}>
            {result.enrolled ? (
              <div style={{ background: c.card, border: `1px solid ${c.gold}`, borderRadius: 14, padding: 20, textAlign: "center", marginBottom: 20 }}>
                <div className="mono" style={{ fontSize: 11, color: c.stone, marginBottom: 6 }}>YOUR BALANCE</div>
                <div style={{ fontSize: 36, fontWeight: 800, color: c.gold }}>{result.points_balance}</div>
                <div style={{ fontSize: 12, color: c.stone, marginTop: 4 }}>points · {result.total_orders} order{result.total_orders === 1 ? "" : "s"}</div>
              </div>
            ) : (
              <p style={{ fontSize: 13, color: c.stone, marginBottom: 20, textAlign: "center" }}>Not enrolled yet — opt in at checkout on your next order to start earning ({result.points_per_order} pts/order).</p>
            )}

            {result.rewards?.length > 0 && (
              <>
                <div className="mono" style={{ fontSize: 11, color: c.gold, letterSpacing: 1, marginBottom: 10 }}>REWARDS</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {result.rewards.map((r) => {
                    const canRedeem = result.enrolled && result.points_balance >= r.points_cost;
                    return (
                      <div key={r.id} style={{ background: c.card, border: `1px solid ${canRedeem ? c.gold : "#2A2420"}`, borderRadius: 10, padding: 12, opacity: canRedeem ? 1 : 0.6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: 13, fontWeight: 700 }}>{r.name}</span>
                          <span className="mono" style={{ fontSize: 12, color: c.gold, fontWeight: 700 }}>{r.points_cost} pts</span>
                        </div>
                        {r.description && <p style={{ fontSize: 11, color: c.stone, marginTop: 4 }}>{r.description}</p>}
                        {canRedeem && <p style={{ fontSize: 10, color: c.green, marginTop: 6 }}>✓ You have enough — mention it at pickup!</p>}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        <a href={`/${slug}`} style={{ display: "block", textAlign: "center", marginTop: 24, fontSize: 12, color: c.stone }}>← Back to menu</a>
      </div>
    </div>
  );
}

function KitchenDashboard({ slug }) {
  const c = { bg: "#0E0B09", card: "#1A1512", gold: "#D4A537", red: "#C4281C", cream: "#F3E9D8", stone: "#8C8074", green: "#4CA466" };
  const pinKey = `kitchen_pin_${slug}`;
  const [pin, setPin] = useState(sessionStorage.getItem(pinKey) || "");
  const [pinInput, setPinInput] = useState("");
  const [truckName, setTruckName] = useState("");
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState("");

  const loadOrders = useCallback(async (activePin) => {
    const data = await fn("kitchen-api", { slug, pin: activePin, action: "list" });
    if (data.error) { setError(data.error); sessionStorage.removeItem(pinKey); setPin(""); return; }
    setError("");
    setTruckName(data.truck_name);
    setOrders(data.orders);
  }, [slug, pinKey]);

  useEffect(() => {
    if (!pin) return;
    loadOrders(pin);
    const interval = setInterval(() => loadOrders(pin), 8000);
    return () => clearInterval(interval);
  }, [pin, loadOrders]);

  const submitPin = async () => {
    setError("");
    const data = await fn("kitchen-api", { slug, pin: pinInput, action: "list" });
    if (data.error) { setError(data.error); return; }
    sessionStorage.setItem(pinKey, pinInput);
    setPin(pinInput);
  };

  const advance = async (orderId) => {
    await fn("kitchen-api", { slug, pin, action: "advance", order_id: orderId });
    loadOrders(pin);
  };

  const statusStyle = { new: c.red, preparing: c.gold, ready: c.green };
  const statusLabel = { new: "NEW — TAP TO START", preparing: "PREPARING — TAP WHEN READY", ready: "READY — TAP TO COMPLETE" };

  if (!pin) {
    return (
      <div style={{ background: c.bg, color: c.cream, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui", padding: 24 }}>
        <div style={{ width: "100%", maxWidth: 280, textAlign: "center" }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Kitchen Access</h1>
          <input
            value={pinInput} onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ""))}
            type="password" inputMode="numeric" placeholder="Enter PIN"
            style={{ width: "100%", textAlign: "center", fontSize: 22, letterSpacing: 6, background: c.card, border: "1px solid #2A2420", borderRadius: 10, padding: "14px", color: c.cream, marginBottom: 12 }}
          />
          {error && <p style={{ color: c.red, fontSize: 12, marginBottom: 12 }}>{error}</p>}
          <button onClick={submitPin} style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "14px", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>Enter</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: c.bg, color: c.cream, minHeight: "100vh", fontFamily: "system-ui" }}>
      <nav style={{ position: "sticky", top: 0, background: "rgba(14,11,9,0.95)", borderBottom: "1px solid #2A2420", padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 800, fontSize: 16 }}>{truckName} — Kitchen</span>
        <span style={{ fontSize: 11, color: c.stone }}>Auto-refreshing</span>
      </nav>
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {orders === null && <p style={{ color: c.stone, textAlign: "center" }}>Loading tickets…</p>}
        {orders?.filter((o) => o.status !== "completed").length === 0 && <p style={{ color: c.stone, textAlign: "center", padding: 40 }}>No active orders.</p>}
        {orders?.filter((o) => o.status !== "completed").map((o) => (
          <div key={o.id} style={{ background: c.card, border: `2px solid ${statusStyle[o.status]}`, borderRadius: 14, padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>#{String(o.order_number).padStart(3, "0")} — {o.customer_name}</div>
                <div style={{ fontSize: 12, color: c.stone, marginTop: 2 }}>
                  {o.fulfillment?.toUpperCase()} · {new Date(o.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </div>
                {o.loyalty_points !== null && o.loyalty_points !== undefined && (
                  <div style={{ fontSize: 11, color: c.gold, marginTop: 2, fontWeight: 700 }}>🎁 {o.loyalty_points} pts</div>
                )}
              </div>
              <span style={{ fontSize: 20, fontWeight: 800, color: c.gold }}>${Number(o.total).toFixed(2)}</span>
            </div>
            <div style={{ borderTop: "1px dashed #3A322C", borderBottom: "1px dashed #3A322C", padding: "10px 0", marginBottom: 12 }}>
              {(o.items || []).map((it, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
                  <span>{it.qty}x {it.name}</span>
                </div>
              ))}
            </div>
            <button onClick={() => advance(o.id)} style={{ width: "100%", background: statusStyle[o.status], color: "#1A1210", border: "none", padding: "14px", borderRadius: 10, fontWeight: 800, fontSize: 13, cursor: "pointer" }}>
              {statusLabel[o.status]}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================= DEMO SITE (sandboxed — always Los Papas, never writes real data) ============================= */
function DemoSite() {
  const [data, setData] = useState({ loading: true, truck: null, theme: null, menu: [], location: null, faqs: [], gallery: [] });

  useEffect(() => {
    (async () => {
      const truckRes = await rest(`trucks?slug=eq.los-papas&select=id,slug,name,tagline,subline,phone,delivery_radius,delivery_fee,rating,review_count,about_text`).then((r) => r.json());
      const truck = truckRes?.[0];
      if (!truck) { setData((s) => ({ ...s, loading: false })); return; }
      const [themeRes, menuRes, locRes, faqRes, galRes] = await Promise.all([
        rest(`truck_theme?truck_id=eq.${truck.id}&select=*`).then((r) => r.json()),
        rest(`menu_items?truck_id=eq.${truck.id}&select=*&order=sort_order`).then((r) => r.json()),
        rest(`truck_location?truck_id=eq.${truck.id}&select=*`).then((r) => r.json()),
        rest(`faqs?truck_id=eq.${truck.id}&select=*`).then((r) => r.json()),
        rest(`gallery_photos?truck_id=eq.${truck.id}&select=*&order=sort_order`).then((r) => r.json()),
      ]);
      setData({ loading: false, truck, theme: themeRes?.[0] || null, menu: menuRes || [], location: locRes?.[0] || null, faqs: faqRes || [], gallery: galRes || [], reload: () => {} });
    })();
  }, []);

  if (data.loading) return <div style={{ background: COLORS_FALLBACK.bg, minHeight: "100vh" }} />;
  if (!data.truck) return <div style={{ background: COLORS_FALLBACK.bg, color: COLORS_FALLBACK.red, minHeight: "100vh", padding: 24 }}>Demo unavailable right now.</div>;

  const c = buildColors(data.theme);

  return (
    <div>
      <div style={{ background: c.gold, color: "#1A1210", textAlign: "center", padding: "8px", fontSize: 12, fontWeight: 700, position: "sticky", top: 0, zIndex: 100 }}>
        DEMO MODE — this is a live example. No orders are actually placed. <a href="/start" style={{ color: "#1A1210", textDecoration: "underline" }}>Create your own →</a>
      </div>
      <CustomerSite c={c} data={data} demoMode />
    </div>
  );
}

/* ============================= TERMS OF SERVICE (public page) ============================= */
function TermsPage() {
  const b = BRAND;
  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 22 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: b.teal, marginBottom: 8 }}>{title}</h2>
      <div style={{ fontSize: 13, color: "#C9C9C9", lineHeight: 1.6 }}>{children}</div>
    </div>
  );
  return (
    <div style={{ background: b.bg, color: b.white, minHeight: "100vh", fontFamily: "system-ui", padding: "24px 20px 60px" }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <a href="/" style={{ fontSize: 12, color: b.stone, textDecoration: "none", display: "block", marginBottom: 20 }}>← VendorGrub</a>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Terms of Service</h1>
        <p style={{ fontSize: 12, color: b.stone, marginBottom: 28 }}>Last updated: {new Date().toLocaleDateString()}</p>

        <Section title="What VendorGrub Is">
          VendorGrub provides software — a website, online ordering, live location updates, an automated chatbot, and a dashboard — that food trucks and other food vendors use to run their own storefront. VendorGrub is a technology provider only. We are not a food business, we are not a party to any sale between you and your customers, and we do not prepare, handle, or sell food.
        </Section>

        <Section title="You Are Responsible for Your Business">
          As a Merchant using VendorGrub, you are the merchant of record for every sale made through your page. You are responsible for holding all licenses and permits required to operate your food business, for food safety and handling, for the accuracy of your menu and pricing, and for fulfilling orders and handling any customer disputes. VendorGrub does not verify licensing or permits — that responsibility is yours alone.
        </Section>

        <Section title="Your Account">
          You're responsible for keeping your login and any Kitchen Access PIN you set confidential, and for all activity under your account. Let us know right away if you think either has been compromised.
        </Section>

        <Section title="Your Content">
          You own your menu, photos, business name, and logo. By uploading them, you give VendorGrub permission to host and display them as part of running your storefront page. You confirm you have the right to use everything you upload.
        </Section>

        <Section title="Payment">
          VendorGrub currently accepts payment for its own service via cash or CashApp, arranged directly with us. Orders placed by your customers are between you and them — VendorGrub does not process customer payments. Non-payment for your VendorGrub subscription may result in your account being paused.
        </Section>

        <Section title="Acceptable Use">
          Don't use VendorGrub to sell anything you're not licensed to sell, misrepresent your business or location, access another Merchant's account or data, or interfere with the platform's operation.
        </Section>

        <Section title="No Warranty, Limited Liability">
          VendorGrub is provided as-is, without warranties of any kind. We aren't liable for indirect or consequential damages, and our total liability is limited to what you've paid us in the past 12 months. We are not liable for any claim, injury, or loss arising from the food you prepare, sell, or serve.
        </Section>

        <Section title="You Protect Us">
          You agree to cover VendorGrub for any claim arising from your food, your licensing, your content, or a dispute with your customers.
        </Section>

        <Section title="Ending Service">
          You can stop using VendorGrub any time. We may suspend or end your access if you violate these terms or misrepresent your licensing.
        </Section>

        <Section title="Changes">
          We may update these terms. Continuing to use VendorGrub after a change means you accept the update.
        </Section>

        <Section title="Contact">
          Questions? Reach out directly to VendorGrub.
        </Section>
      </div>
    </div>
  );
}

function TruckDirectory() {
  const [trucks, setTrucks] = useState(null);
  useEffect(() => {
    rest(`trucks?is_active=eq.true&is_listed=eq.true&select=slug,name,tagline`).then((r) => r.json()).then(setTrucks).catch(() => setTrucks([]));
  }, []);
  return (
    <div style={{ background: COLORS_FALLBACK.bg, color: COLORS_FALLBACK.cream, minHeight: "100vh", fontFamily: "system-ui", padding: 24 }}>
      <a href="/" style={{ fontSize: 12, color: COLORS_FALLBACK.stone, textDecoration: "none", display: "block", marginBottom: 12 }}>← VendorGrub</a>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Food Trucks</h1>
      {trucks === null && <p style={{ color: COLORS_FALLBACK.stone, fontSize: 13 }}>Loading…</p>}
      {trucks?.length === 0 && <p style={{ color: COLORS_FALLBACK.stone, fontSize: 13 }}>No trucks yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
        {trucks?.map((t) => (
          <a key={t.slug} href={`/${t.slug}`} style={{ background: COLORS_FALLBACK.card, border: "1px solid #2A2420", borderRadius: 12, padding: 16, textDecoration: "none", color: COLORS_FALLBACK.cream }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{t.name}</div>
            {t.tagline && <div style={{ fontSize: 12, color: COLORS_FALLBACK.stone, marginTop: 4 }}>{t.tagline}</div>}
          </a>
        ))}
      </div>
      <a href="/start" style={{ display: "block", textAlign: "center", background: COLORS_FALLBACK.gold, color: "#1A1210", padding: "12px", borderRadius: 999, fontWeight: 700, fontSize: 13, textDecoration: "none" }}>
        + Create Your Own Truck Site
      </a>
    </div>
  );
}

export default function App() {
  const data = useTruckData();
  const [session, setSession] = useState(null); // { access_token, email }

  if (!PATH_SLUG) {
    return <LandingPage />;
  }
  if (PATH_SLUG === "trucks") {
    return <TruckDirectory />;
  }
  if (PATH_SLUG === "start") {
    return <SelfOnboard />;
  }
  if (PATH_SLUG === "demo") {
    return <DemoSite />;
  }
  if (PATH_SLUG === "terms") {
    return <TermsPage />;
  }
  if (PATH_SLUG === "admin") {
    return <AdminHome />;
  }
  if (PATH_SLUG === "login") {
    return <OwnerLogin />;
  }
  if (PATH_SUB === "kitchen") {
    return <KitchenDashboard slug={PATH_SLUG} />;
  }
  if (PATH_SUB === "rewards") {
    return <RewardsCheck slug={PATH_SLUG} />;
  }
  if (PATH_SUB === "unsubscribe") {
    return <UnsubscribePage slug={PATH_SLUG} />;
  }

  if (data.loading) {
    return <div style={{ background: COLORS_FALLBACK.bg, color: COLORS_FALLBACK.cream, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui" }}>Loading…</div>;
  }
  if (data.error || !data.truck) {
    return <div style={{ background: COLORS_FALLBACK.bg, color: COLORS_FALLBACK.red, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, textAlign: "center", fontFamily: "system-ui" }}>Couldn't load truck data: {data.error || "not found"}</div>;
  }

  const c = buildColors(data.theme);

  if (PATH_SUB === "manage") {
    return <OwnerDashboard c={c} data={data} session={session} setSession={setSession} goSite={() => { data.reload(); window.location.href = `/${PATH_SLUG}`; }} />;
  }

  return <CustomerSite c={c} data={data} />;
}

/* ============================= CUSTOMER SITE ============================= */
function CustomerSite({ c, data, demoMode }) {
  const { truck, menu, location, faqs, categories } = data;
  const [cart, setCart] = useState({}); // { menu_item_id: qty }
  const [quickView, setQuickView] = useState(null);
  const [modalQty, setModalQty] = useState(1);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [fullMenuOpen, setFullMenuOpen] = useState(false);
  const featuredScrollRef = useRef(null);
  const [menuBrowserOpen, setMenuBrowserOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState("all");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [fulfillment, setFulfillment] = useState("pickup");
  const [address, setAddress] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [joinLoyalty, setJoinLoyalty] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { success, order_id, total } | { error }
  const [confirmedItems, setConfirmedItems] = useState([]);

  // Any of these fixed-overlay modals being open should stop the page
  // behind it from scrolling — without this, scrolling inside the modal
  // on mobile chains through to the page once the modal content hits its
  // own scroll boundary, dragging the page (and whatever's below, like the
  // location map) up behind the still-open modal.
  const modalOpen = !!quickView || checkoutOpen || !!result || fullMenuOpen || menuBrowserOpen || aboutOpen;
  useEffect(() => {
    if (!modalOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prevOverflow; };
  }, [modalOpen]);

  const addToOrder = (item, qty = 1) => setCart((prev) => ({ ...prev, [item.id]: (prev[item.id] || 0) + qty }));

  // Sparkle burst + fly-to-cart — pure DOM, self-cleaning, no state needed.
  // Fires from wherever "Add to Order" was tapped, gives tactile feedback
  // that the tap actually landed, without any animation library.
  const burstFromButton = (buttonEl, item) => {
    if (!buttonEl) return;
    const rect = buttonEl.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    const sparkleColors = [c.gold, c.red, "#fff"];

    for (let i = 0; i < 8; i++) {
      const s = document.createElement("div");
      const angle = (Math.PI * 2 * i) / 8 + Math.random() * 0.4;
      const dist = 36 + Math.random() * 26;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      s.style.cssText = `position:fixed; left:${originX}px; top:${originY}px; width:6px; height:6px; border-radius:50%; background:${sparkleColors[i % sparkleColors.length]}; pointer-events:none; z-index:200; transform:translate(-50%,-50%); opacity:1; transition: transform 0.6s cubic-bezier(.2,.8,.2,1), opacity 0.6s ease;`;
      document.body.appendChild(s);
      requestAnimationFrame(() => {
        s.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.3)`;
        s.style.opacity = "0";
      });
      setTimeout(() => s.remove(), 650);
    }

    const ghost = document.createElement("div");
    ghost.style.cssText = `position:fixed; left:${originX}px; top:${originY}px; width:34px; height:34px; border-radius:50%; background:${item.photo_url ? `url(${item.photo_url}) center/cover` : c.red}; pointer-events:none; z-index:200; transform:translate(-50%,-50%) scale(1); opacity:1; box-shadow:0 4px 14px rgba(0,0,0,0.35); transition: left 0.55s cubic-bezier(.3,.6,.3,1), top 0.55s cubic-bezier(.3,.6,.3,1), transform 0.55s ease, opacity 0.55s ease;`;
    document.body.appendChild(ghost);
    requestAnimationFrame(() => {
      ghost.style.left = `${window.innerWidth / 2}px`;
      ghost.style.top = `${window.innerHeight - 36}px`;
      ghost.style.transform = "translate(-50%,-50%) scale(0.2)";
      ghost.style.opacity = "0.3";
    });
    setTimeout(() => ghost.remove(), 600);
  };
  const changeQty = (id, delta) => setCart((prev) => ({ ...prev, [id]: Math.max(0, (prev[id] || 0) + delta) }));
  const cartEntries = Object.entries(cart).filter(([, n]) => n > 0);
  const cartCount = cartEntries.reduce((a, [, n]) => a + n, 0);
  const itemsTotal = cartEntries.reduce((sum, [id, n]) => {
    const item = menu.find((m) => m.id === id);
    return sum + (item ? Number(item.price) * n : 0);
  }, 0);
  const total = itemsTotal + (fulfillment === "delivery" ? Number(truck.delivery_fee || 0) : 0);

  // "circuit" is currently the one template (Neon Pulse) built around glow/
  // glass treatment rather than a flat card + simple pattern — gated on a
  // real theme field rather than the template key so it stays data-driven.
  const isNeon = data.theme?.decoration === "circuit" && !!c.accent2;

  // Sweetheart's Featured Menu reads as a paged carousel (arrows + a Full
  // Menu modal) instead of the plain 2-column grid every other "grid"
  // template still uses — gated on its own decoration field, same pattern
  // as isNeon, so it's data-driven rather than a hardcoded template check.
  const isSweetheart = data.theme?.decoration === "dots";
  const arrowBtnStyle = (side) => ({
    position: "absolute", top: "40%", [side]: 6, transform: "translateY(-50%)",
    width: 34, height: 34, borderRadius: "50%", border: "none", cursor: "pointer",
    background: c.card, color: c.gold, boxShadow: "0 2px 10px rgba(0,0,0,0.25)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2,
  });

  // Atelier's nav becomes MENU / CATERING / ABOUT / CONTACT, Menu opens a
  // category-filterable browser instead of the plain Full Menu list, About
  // opens a modal instead of the inline page section — all gated the same
  // data-driven way as isNeon/isSweetheart.
  const isAtelier = data.theme?.decoration === "floral";
  const navLinkStyle = { background: "none", border: "none", color: c.cream, fontSize: 11, letterSpacing: 1.2, fontWeight: 600, cursor: "pointer", textDecoration: "none", fontFamily: "inherit", padding: 0 };
  const categoryPillStyle = (active) => ({
    flexShrink: 0, background: active ? c.gold : "none", color: active ? c.bg : c.stone,
    border: `1px solid ${active ? c.gold : c.border}`, borderRadius: 999, padding: "8px 14px",
    fontSize: 11, fontWeight: 700, letterSpacing: 0.5, cursor: "pointer", whiteSpace: "nowrap",
  });

  // Shared by the Featured Menu grid/scroll and the curated Popular Items /
  // Special Deals shelves, so a menu-item card looks and behaves identically
  // everywhere it appears. `asScroll` overrides the truck's own menu_layout
  // for curated shelves, which read better as a horizontal strip regardless
  // of how the full catalog below is laid out.
  const renderCard = (item, i, asScroll) => {
    const isGrid = !asScroll && data.theme?.menu_layout === "grid";
    const inCart = cart[item.id] || 0;
    return (
      <Reveal key={item.id} delay={i * 80}>
        <div style={{
          ...(isGrid ? { width: "100%" } : { scrollSnapAlign: "start", width: 250, flexShrink: 0 }),
          background: isNeon ? `${c.card}CC` : c.card,
          backdropFilter: isNeon ? "blur(10px)" : undefined,
          borderRadius: 16, overflow: "hidden", opacity: item.sold_out ? 0.5 : 1,
          border: isNeon ? `1px solid ${c.accent2}66` : `1px solid ${c.border}`,
          boxShadow: isNeon ? `0 0 18px ${c.accent2}26` : undefined,
        }}>
          <div onClick={() => { setQuickView(item); setModalQty(1); }} className="checker" style={{ height: 130, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", backgroundImage: item.photo_url ? `url(${item.photo_url})` : undefined, backgroundSize: "cover", backgroundPosition: "center", cursor: "pointer" }}>
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(14,11,9,0.15), rgba(14,11,9,0.75))" }} />
            {item.tag && !item.sold_out && (
              <span style={{ position: "absolute", top: 10, left: 10, background: c.red, color: "#fff", fontSize: 10, fontWeight: 700, padding: "4px 8px", borderRadius: 999, display: "flex", alignItems: "center", gap: 4, zIndex: 1 }}>
                <Flame size={10} /> {item.tag}
              </span>
            )}
            {item.sold_out && <span style={{ position: "absolute", top: 10, left: 10, background: c.borderStrong, color: c.stone, fontSize: 10, fontWeight: 700, padding: "4px 8px", borderRadius: 999, zIndex: 1 }}>SOLD OUT</span>}
            {!item.photo_url && <span className="mono" style={{ position: "relative", zIndex: 1, color: c.stone, fontSize: 10 }}>[ photo: {item.name} ]</span>}
          </div>
          <div style={{ padding: 14 }}>
            <div onClick={() => { setQuickView(item); setModalQty(1); }} style={{ cursor: "pointer" }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{item.name}</h3>
              <p style={{ fontSize: 12, color: c.stone, marginBottom: 10, lineHeight: 1.4, minHeight: 32 }}>{item.description}</p>
            </div>
            {item.promo_tag === "deal" && item.promo_note && (
              <p style={{ fontSize: 11, color: c.red, fontWeight: 700, marginBottom: 10 }}>🏷 {item.promo_note}</p>
            )}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <span className="mono" style={{ color: c.gold, fontWeight: 700, fontSize: 16 }}>${Number(item.price).toFixed(2)}</span>
              <div style={{ display: "flex", gap: 6, fontSize: 10, color: c.stone, alignItems: "center" }}><Clock size={11} /> {item.prep_time}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <SpiceDots level={item.spice_level} c={c} />
              {inCart > 0 && (
                <div id={`qty-pill-${item.id}`} style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, background: c.bg, borderRadius: 999, padding: "4px 8px" }}>
                  <button onClick={() => changeQty(item.id, -1)} style={{ background: "none", border: "none", color: c.cream, cursor: "pointer" }}><Minus size={13} /></button>
                  <span className="mono" style={{ fontSize: 12, width: 14, textAlign: "center" }}>{inCart}</span>
                  <button onClick={() => changeQty(item.id, 1)} style={{ background: "none", border: "none", color: c.cream, cursor: "pointer" }}><Plus size={13} /></button>
                </div>
              )}
            </div>
            <button id={`add-btn-${item.id}`} disabled={item.sold_out} onClick={(e) => { addToOrder(item); burstFromButton(e.currentTarget, item); }} style={{ position: "relative", overflow: "visible", width: "100%", background: item.sold_out ? c.borderStrong : c.red, color: "#fff", border: "none", padding: "10px", borderRadius: 10, fontWeight: 700, fontSize: 12, cursor: item.sold_out ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, boxShadow: isNeon && !item.sold_out ? `0 0 14px ${c.red}66` : undefined }}>
              <ShoppingCart size={13} /> {item.sold_out ? "SOLD OUT" : "ADD TO ORDER"}
            </button>
          </div>
        </div>
      </Reveal>
    );
  };
  const popularItems = menu.filter((m) => m.promo_tag === "popular");
  const dealItems = menu.filter((m) => m.promo_tag === "deal");
  // Category pills above Featured Menu (every template except Atelier,
  // which has its own dedicated category-browsing modal instead).
  const menuFiltered = activeCategory === "all" ? menu : menu.filter((item) => item.category_id === activeCategory);

  const confirmOrder = async () => {
    setSubmitting(true);
    const res = demoMode
      ? { success: true, total, order_id: "demo" }
      : await fn("public-submit", {
          type: "order",
          truck_slug: truck.slug,
          customer_name: customerName || "Guest",
          customer_phone: customerPhone,
          customer_email: customerEmail || undefined,
          items: cartEntries.map(([menu_item_id, qty]) => ({ menu_item_id, qty })),
          fulfillment,
          delivery_address: fulfillment === "delivery" ? address : undefined,
          join_loyalty: joinLoyalty,
        });
    setSubmitting(false);
    setResult(res);
    if (res.success) {
      setConfirmedItems(cartEntries.map(([id, qty]) => {
        const item = menu.find((m) => m.id === id);
        return { name: item?.name || "Item", qty, price: Number(item?.price || 0) };
      }));
      setCheckoutOpen(false);
      setCart({});
    }
  };

  const deco = decorationPattern(data.theme?.decoration, c.red, c.cream);
  return (
    <div style={{ background: c.bg, color: c.cream, fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100vh", paddingBottom: cartCount ? 84 : 0 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Kaushan+Script&family=Pacifico&family=Anton&family=Bebas+Neue&family=Permanent+Marker&family=Alex+Brush&family=JetBrains+Mono:wght@400;600&family=Oswald:wght@500;600;700&family=Quicksand:wght@500;600;700&family=Fredoka:wght@500;600;700&family=Orbitron:wght@600;700;800&family=Playfair+Display:wght@600;700;800&display=swap');
        .script { font-family: 'Kaushan Script', cursive; } .mono { font-family: 'JetBrains Mono', monospace; } .display { font-family: ${HEADING_FONTS[data.theme?.heading_font]?.family || HEADING_FONTS.oswald.family}; text-transform: uppercase; }
        .hud-dot { animation: pulse 1.6s ease-in-out infinite; } @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .checker { background-image: ${deco.backgroundImage}; background-size: ${deco.backgroundSize}; }
        .scrollx::-webkit-scrollbar { display: none; }
        .neon-gradient-text { background-size: 200% auto; -webkit-background-clip: text; background-clip: text; color: transparent; animation: neonShift 5s ease-in-out infinite; }
        @keyframes neonShift { 0%{background-position:0% center} 50%{background-position:100% center} 100%{background-position:0% center} }
        @media (prefers-reduced-motion: reduce) { .neon-gradient-text { animation: none; background-position: 0% center; } }
      `}</style>

      <nav style={{ position: "sticky", top: 0, zIndex: 40, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)", borderBottom: `1px solid ${c.border}` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", rowGap: 8, padding: "12px 20px" }}>
          {data.theme?.logo_url ? <img src={data.theme.logo_url} alt={truck.name} style={{ height: 32 }} /> : <span style={{ fontFamily: (NAME_FONTS[data.theme?.font_key]?.family) || NAME_FONTS.kaushan.family, fontSize: 26, color: c.gold, flexShrink: 0 }}>{truck.name}</span>}
          {isAtelier ? (
            <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", gap: 14, flex: "1 1 auto", minWidth: 0 }}>
              <button onClick={() => { setActiveCategory("all"); setMenuBrowserOpen(true); }} style={navLinkStyle}>MENU</button>
              <a href={`tel:${truck.phone}`} style={navLinkStyle}>CATERING</a>
              <button onClick={() => setAboutOpen(true)} style={navLinkStyle}>ABOUT</button>
              <a href={`tel:${truck.phone}`} style={navLinkStyle}>CONTACT</a>
            </div>
          ) : (
            <a href={`tel:${truck.phone}`} style={{ display: "flex", alignItems: "center", gap: 6, background: c.gold, color: "#1A1210", padding: "8px 14px", borderRadius: 999, fontWeight: 700, fontSize: 13, textDecoration: "none" }}>
              <Phone size={14} /> Call
            </a>
          )}
        </div>
      </nav>

      <div style={{ background: c.navBg, borderBottom: `1px solid ${c.border}`, padding: "9px 16px", display: "flex", alignItems: "center", gap: 10, overflow: "hidden" }}>
        <span className="hud-dot" style={{ width: 7, height: 7, borderRadius: "50%", background: location?.status === "OPEN" ? c.gold : c.stone, flexShrink: 0 }} />
        <FitText
          className="mono"
          style={{ letterSpacing: 1, color: c.gold }}
          maxSize={11}
          minSize={7.5}
          text={location?.status === "OPEN" ? `LIVE — Parked at ${location.spot} until ${location.open_until} · OPEN NOW` : "CLOSED — check back soon"}
        />
      </div>

      <section style={{ position: "relative", height: data.theme?.hero_photo_url ? 220 : 0, overflow: "hidden", backgroundImage: data.theme?.hero_photo_url ? `linear-gradient(${c.bg}26, ${c.bg}F5), url(${data.theme.hero_photo_url})` : undefined, backgroundSize: "cover", backgroundPosition: "center" }} />

      <section style={{ position: "relative", padding: "84px 20px 40px", overflow: "hidden", border: isNeon ? `1px solid ${c.accent2}33` : undefined, borderLeft: "none", borderRight: "none" }}>
        {!data.theme?.hero_photo_url && <div style={{ position: "absolute", inset: 0, background: heroWashCss(data.theme?.decoration, c.red, c.accent2) }} />}
        {isNeon && <CornerBrackets color={c.accent2} />}
        {isAtelier && <FloralCorners color={c.gold} />}
        <Reveal>
          <div style={{ position: "relative", zIndex: 1, ...(isAtelier ? { textAlign: "center" } : {}) }}>
            <span className="mono" style={{ fontSize: 11, letterSpacing: 3, color: c.gold }}>{(truck.tagline || "").toUpperCase()}</span>
            <h1
              className={isNeon ? "neon-gradient-text" : undefined}
              style={{
                fontFamily: (NAME_FONTS[data.theme?.font_key]?.family) || NAME_FONTS.kaushan.family,
                fontSize: "clamp(40px, 12vw, 56px)", lineHeight: (isNeon || isAtelier) ? 1.08 : 1, margin: "8px 0 12px",
                ...(isNeon ? { textAlign: "center", backgroundImage: `linear-gradient(90deg, ${c.cream}, ${c.gold}, ${c.accent2}, ${c.cream})` } : { color: c.cream }),
              }}
            >
              {truck.name}
            </h1>
            <p style={{ color: c.stone, fontSize: 15, maxWidth: 340 }}>{truck.subline}</p>
          </div>
        </Reveal>
      </section>

      <section id="menu" style={{ padding: "8px 0 32px" }}>
        <Reveal>
          <div style={{ padding: "0 20px", marginBottom: 16, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div>
              <span className="mono" style={{ fontSize: 11, letterSpacing: 2, color: c.gold }}>SOMETHING FOR EVERYONE</span>
              <h2 className="display" style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>Featured Menu</h2>
            </div>
            {isSweetheart && menu.length > 0 && (
              <button onClick={() => setFullMenuOpen(true)} style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: `1.5px solid ${c.gold}`, color: c.gold, borderRadius: 999, padding: "8px 14px", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, marginTop: 2 }}>
                VIEW FULL MENU <ArrowRight size={13} />
              </button>
            )}
          </div>
        </Reveal>
        {!isAtelier && (categories || []).length > 0 && (
          <div className="scrollx" style={{ display: "flex", gap: 8, overflowX: "auto", padding: "0 20px 16px" }}>
            <button onClick={() => setActiveCategory("all")} style={categoryPillStyle(activeCategory === "all")}>ALL</button>
            {categories.map((cat) => (
              <button key={cat.id} onClick={() => setActiveCategory(cat.id)} style={categoryPillStyle(activeCategory === cat.id)}>{(cat.name || "").toUpperCase()}</button>
            ))}
          </div>
        )}
        {isSweetheart ? (
          <div style={{ position: "relative" }}>
            <div ref={featuredScrollRef} className="scrollx" style={{ display: "flex", gap: 14, overflowX: "auto", padding: "0 20px 8px", scrollSnapType: "x mandatory" }}>
              {menuFiltered.map((item, i) => renderCard(item, i, true))}
            </div>
            {menuFiltered.length > 1 && (
              <>
                <button onClick={() => featuredScrollRef.current?.scrollBy({ left: -264, behavior: "smooth" })} aria-label="Previous items" style={arrowBtnStyle("left")}><ChevronLeft size={18} /></button>
                <button onClick={() => featuredScrollRef.current?.scrollBy({ left: 264, behavior: "smooth" })} aria-label="Next items" style={arrowBtnStyle("right")}><ChevronRight size={18} /></button>
              </>
            )}
          </div>
        ) : data.theme?.menu_layout === "grid" ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, padding: "0 20px 8px" }}>
            {menuFiltered.map((item, i) => renderCard(item, i))}
          </div>
        ) : (
          <div className="scrollx" style={{ display: "flex", gap: 14, overflowX: "auto", padding: "0 20px 8px", scrollSnapType: "x mandatory" }}>
            {menuFiltered.map((item, i) => renderCard(item, i))}
          </div>
        )}
      </section>

      {popularItems.length > 0 && (
        <section style={{ padding: "8px 0 32px" }}>
          <Reveal>
            <div style={{ padding: "0 20px", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
              <Star size={16} color={c.gold} />
              <h2 className="display" style={{ fontSize: 22, fontWeight: 700 }}>Popular Items</h2>
            </div>
          </Reveal>
          <div className="scrollx" style={{ display: "flex", gap: 14, overflowX: "auto", padding: "0 20px 8px", scrollSnapType: "x mandatory" }}>
            {popularItems.map((item, i) => renderCard(item, i, true))}
          </div>
        </section>
      )}

      {dealItems.length > 0 && (
        <section style={{ padding: "8px 0 32px", background: c.card, borderTop: `1px solid ${c.border}`, borderBottom: `1px solid ${c.border}` }}>
          <Reveal>
            <div style={{ padding: "20px 20px 16px", display: "flex", alignItems: "center", gap: 8 }}>
              <Flame size={16} color={c.red} />
              <h2 className="display" style={{ fontSize: 22, fontWeight: 700 }}>Special Deals</h2>
            </div>
          </Reveal>
          <div className="scrollx" style={{ display: "flex", gap: 14, overflowX: "auto", padding: "0 20px 20px", scrollSnapType: "x mandatory" }}>
            {dealItems.map((item, i) => renderCard(item, i, true))}
          </div>
        </section>
      )}

      {truck.about_text && !isAtelier && (
        <section style={{ padding: "36px 20px" }}>
          <Reveal>
            <span className="mono" style={{ fontSize: 11, letterSpacing: 2, color: c.gold }}>OUR STORY</span>
            <h2 className="display" style={{ fontSize: 22, fontWeight: 700, margin: "6px 0 12px" }}>About {truck.name}</h2>
            <p style={{ color: c.stone, fontSize: 14, lineHeight: 1.7, maxWidth: 480, whiteSpace: "pre-wrap" }}>{truck.about_text}</p>
          </Reveal>
        </section>
      )}

      <section style={{ padding: "36px 20px", background: c.card, borderTop: `1px solid ${c.border}`, borderBottom: `1px solid ${c.border}` }}>
        <Reveal>
          <span className="mono" style={{ fontSize: 11, letterSpacing: 2, color: c.gold }}>FEEDING A CROWD?</span>
          <h2 className="display" style={{ fontSize: 22, fontWeight: 700, margin: "6px 0 10px" }}>Book {truck.name} for Your Event</h2>
          <p style={{ color: c.stone, fontSize: 13, marginBottom: 16, maxWidth: 420 }}>Birthdays, offices, weekends — tell us the headcount and date, we'll handle the rest.</p>
          <a href={`tel:${truck.phone}`} style={{ background: c.gold, color: "#1A1210", padding: "12px 22px", borderRadius: 999, fontWeight: 700, fontSize: 14, textDecoration: "none", display: "inline-block" }}>Request Catering</a>
        </Reveal>
      </section>

      {location?.lat != null && location?.lng != null && (
        <section style={{ padding: "32px 20px 8px" }}>
          <Reveal>
            <span className="mono" style={{ fontSize: 11, letterSpacing: 2, color: c.gold }}>FIND US</span>
            <h2 className="display" style={{ fontSize: 22, fontWeight: 700, margin: "6px 0 14px" }}>Where We're Parked</h2>
          </Reveal>
          <div style={{ height: 220, borderRadius: 16, overflow: "hidden", border: `1px solid ${c.border}` }}>
            <MapContainer center={[location.lat, location.lng]} zoom={15} style={{ height: "100%", width: "100%" }} scrollWheelZoom={false}>
              <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <Marker position={[location.lat, location.lng]} />
            </MapContainer>
          </div>
          {location.spot && (
            <p style={{ fontSize: 12, color: c.stone, marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
              <MapPin size={13} color={c.gold} /> {location.spot}
            </p>
          )}
        </section>
      )}

      <footer style={{ padding: "36px 20px 28px" }}>
        <span style={{ fontFamily: (NAME_FONTS[data.theme?.font_key]?.family) || NAME_FONTS.kaushan.family, fontSize: 24, color: c.gold }}>{truck.name}</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16, fontSize: 13, color: c.stone }}>
          <a href={`tel:${truck.phone}`} style={{ color: c.cream, textDecoration: "none", display: "flex", alignItems: "center", gap: 8 }}><Phone size={14} color={c.gold} /> {truck.phone}</a>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><MapPin size={14} color={c.gold} /> {location?.spot || "—"} — today</span>
          <div style={{ display: "flex", gap: 14, marginTop: 6 }}><Instagram size={18} color={c.stone} /><Facebook size={18} color={c.stone} /></div>
        </div>
        <div className="checker" style={{ height: 4, borderRadius: 2, marginTop: 24, opacity: 0.5 }} />
        <p className="mono" style={{ fontSize: 10, color: c.footerMuted, marginTop: 16 }}>© {new Date().getFullYear()} {truck.name}. Built with pride in Corpus Christi.</p>
        <a href="/" className="mono" style={{ display: "inline-block", marginTop: 8, fontSize: 10, fontWeight: 700, color: "#2FBFD4", textDecoration: "none", letterSpacing: 0.5 }}>Powered by VendorGrub</a>
      </footer>

      {cartCount > 0 && !checkoutOpen && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: c.gold, padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", zIndex: 50 }}>
          <span className="mono" style={{ color: "#1A1210", fontWeight: 700, fontSize: 13 }}>{cartCount} item{cartCount > 1 ? "s" : ""} · ${itemsTotal.toFixed(2)}</span>
          <button onClick={() => { setResult(null); setCheckoutOpen(true); }} style={{ background: "#1A1210", color: c.gold, border: "none", padding: "10px 18px", borderRadius: 999, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Checkout</button>
        </div>
      )}

      {checkoutOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "flex-end", zIndex: 60 }}>
          <div style={{ background: c.card, borderRadius: "20px 20px 0 0", padding: 22, width: "100%", maxHeight: "85vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span className="display" style={{ fontSize: 18, fontWeight: 700 }}>Checkout</span>
              <button onClick={() => setCheckoutOpen(false)} style={{ background: "none", border: "none", color: c.stone, cursor: "pointer" }}><X size={20} /></button>
            </div>

            <label className="mono" style={{ fontSize: 11, color: c.stone }}>YOUR ORDER</label>
            <div style={{ marginTop: 8, marginBottom: 18 }}>
              {cartEntries.map(([id, qty]) => {
                const item = menu.find((m) => m.id === id);
                if (!item) return null;
                return (
                  <div key={id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${c.border}` }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: c.cream }}>{item.name}</div>
                      <div className="mono" style={{ fontSize: 11, color: c.stone }}>${Number(item.price).toFixed(2)} each</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, background: c.bg, borderRadius: 999, padding: "4px 8px" }}>
                      <button onClick={() => changeQty(id, -1)} style={{ background: "none", border: "none", color: c.cream, cursor: "pointer" }}><Minus size={13} /></button>
                      <span className="mono" style={{ fontSize: 12, width: 14, textAlign: "center" }}>{qty}</span>
                      <button onClick={() => changeQty(id, 1)} style={{ background: "none", border: "none", color: c.cream, cursor: "pointer" }}><Plus size={13} /></button>
                    </div>
                    <button onClick={() => setCart((prev) => { const next = { ...prev }; delete next[id]; return next; })} style={{ background: "none", border: "none", color: c.red, cursor: "pointer" }}><Trash2 size={15} /></button>
                  </div>
                );
              })}
              {cartEntries.length === 0 && <p style={{ fontSize: 12, color: c.stone, padding: "10px 0" }}>Your cart is empty.</p>}
            </div>

            <label className="mono" style={{ fontSize: 11, color: c.stone }}>YOUR NAME</label>
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="First name" style={{ width: "100%", background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginTop: 6, marginBottom: 16, fontSize: 14 }} />

            <label className="mono" style={{ fontSize: 11, color: c.stone }}>PHONE NUMBER</label>
            <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="(361) 555-1234" type="tel" style={{ width: "100%", background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginTop: 6, marginBottom: 16, fontSize: 14 }} />

            <label className="mono" style={{ fontSize: 11, color: c.stone }}>EMAIL (OPTIONAL — for order updates & discounts)</label>
            <input value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="you@email.com" type="email" style={{ width: "100%", background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginTop: 6, marginBottom: 16, fontSize: 14 }} />

            {data.loyalty?.enabled && !demoMode && (
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 16, cursor: "pointer", background: `${c.gold}14`, border: `1px solid ${c.gold}55`, borderRadius: 10, padding: 12 }}>
                <input type="checkbox" checked={joinLoyalty} onChange={(e) => setJoinLoyalty(e.target.checked)} style={{ marginTop: 2 }} />
                <span style={{ fontSize: 12, color: c.cream, lineHeight: 1.4 }}>
                  🎁 Join {truck.name}'s rewards program and earn <strong>{data.loyalty.points_per_order} points</strong> on this order.
                </span>
              </label>
            )}

            <label className="mono" style={{ fontSize: 11, color: c.stone }}>PICKUP OR DELIVERY</label>
            <div style={{ display: "flex", gap: 10, marginTop: 8, marginBottom: 16 }}>
              <button onClick={() => setFulfillment("pickup")} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "14px 8px", borderRadius: 12, border: `1px solid ${fulfillment === "pickup" ? c.gold : c.border}`, background: fulfillment === "pickup" ? `${c.gold}1A` : "transparent", color: fulfillment === "pickup" ? c.gold : c.stone, cursor: "pointer" }}>
                <Store size={18} /><span style={{ fontSize: 12, fontWeight: 600 }}>Pickup at Truck</span>
              </button>
              <button onClick={() => setFulfillment("delivery")} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "14px 8px", borderRadius: 12, border: `1px solid ${fulfillment === "delivery" ? c.gold : c.border}`, background: fulfillment === "delivery" ? `${c.gold}1A` : "transparent", color: fulfillment === "delivery" ? c.gold : c.stone, cursor: "pointer" }}>
                <Truck size={18} /><span style={{ fontSize: 12, fontWeight: 600 }}>Delivery</span>
              </button>
            </div>

            {fulfillment === "delivery" && (
              <>
                <label className="mono" style={{ fontSize: 11, color: c.stone }}>DELIVERY ADDRESS{truck.delivery_radius ? ` (within ${truck.delivery_radius})` : ""}</label>
                <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street address" style={{ width: "100%", background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginTop: 6, marginBottom: 16, fontSize: 14 }} />
              </>
            )}

            <div style={{ borderTop: `1px solid ${c.border}`, paddingTop: 14, marginBottom: 14 }}>
              {cartEntries.map(([id, qty]) => {
                const item = menu.find((m) => m.id === id);
                if (!item) return null;
                return (
                  <div key={id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: c.cream, marginBottom: 6 }}>
                    <span>{qty}x {item.name}</span>
                    <span className="mono">${(Number(item.price) * qty).toFixed(2)}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ borderTop: `1px solid ${c.border}`, paddingTop: 14, marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: c.stone, marginBottom: 6 }}><span>Subtotal</span><span className="mono">${itemsTotal.toFixed(2)}</span></div>
              {fulfillment === "delivery" && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: c.stone, marginBottom: 6 }}><span>Delivery fee</span><span className="mono">${Number(truck.delivery_fee || 0).toFixed(2)}</span></div>}
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 700, color: c.cream, marginTop: 8 }}><span>Total (pay {fulfillment === "pickup" ? "at truck" : "on delivery"})</span><span className="mono" style={{ color: c.gold }}>${total.toFixed(2)}</span></div>
            </div>

            {result?.error && <p style={{ color: c.red, fontSize: 12, marginBottom: 12 }}>{result.error}</p>}

            <button onClick={confirmOrder} disabled={submitting || cartEntries.length === 0 || !customerPhone.trim() || (fulfillment === "delivery" && !address)} style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "14px", borderRadius: 12, fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: submitting || cartEntries.length === 0 || !customerPhone.trim() || (fulfillment === "delivery" && !address) ? 0.5 : 1 }}>
              {submitting ? "Placing order…" : "Confirm Order"}
            </button>
          </div>
        </div>
      )}

      {result?.success && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 20 }}>
          <div style={{ background: c.card, border: `1px solid ${c.gold}`, borderRadius: 16, padding: 28, textAlign: "center", maxWidth: 300, position: "relative" }}>
            <button onClick={() => setResult(null)} style={{ position: "absolute", top: 10, right: 10, background: "none", border: "none", color: c.stone, cursor: "pointer" }}><X size={18} /></button>
            <span className="script" style={{ fontSize: 22, color: c.gold }}>{demoMode ? "This Was a Demo!" : "Order Sent!"}</span>
            {demoMode && <p style={{ fontSize: 11, color: c.gold, marginTop: 6 }}>No real order was placed — this is just a preview of what your customers would see.</p>}
            {!demoMode && result?.loyalty_points_earned > 0 && (
              <p style={{ fontSize: 12, color: c.gold, marginTop: 8, fontWeight: 700 }}>🎁 You earned {result.loyalty_points_earned} points!</p>
            )}
            <div style={{ textAlign: "left", margin: "14px 0", borderTop: `1px dashed ${c.borderStrong}`, borderBottom: `1px dashed ${c.borderStrong}`, padding: "10px 0" }}>
              {confirmedItems.map((it, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: c.cream, marginBottom: 4 }}>
                  <span>{it.qty}x {it.name}</span>
                  <span className="mono">${(it.price * it.qty).toFixed(2)}</span>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 13, color: c.stone, marginTop: 10 }}>
              {fulfillment === "pickup" ? `Head to ${location?.spot} and pay at the window when you grab it.` : `We'll text you when it's on the way — pay the driver on delivery.`}
            </p>
            <p className="mono" style={{ fontSize: 10, color: c.stone, marginTop: 10 }}>Order total: ${Number(result.total).toFixed(2)}</p>
          </div>
        </div>
      )}

      {quickView && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 70, display: "flex", alignItems: "flex-end" }} onClick={() => setQuickView(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: c.card, borderRadius: "20px 20px 0 0", width: "100%", maxHeight: "92vh", overflowY: "auto" }}>
            <div className="checker" style={{ position: "relative", width: "100%", aspectRatio: "1", backgroundImage: quickView.photo_url ? `url(${quickView.photo_url})` : undefined, backgroundSize: "cover", backgroundPosition: "center" }}>
              <button onClick={() => setQuickView(null)} style={{ position: "absolute", top: 14, right: 14, background: "rgba(0,0,0,0.6)", border: "none", borderRadius: "50%", width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><X size={18} color="#fff" /></button>
              {quickView.tag && !quickView.sold_out && (
                <span style={{ position: "absolute", top: 14, left: 14, background: c.red, color: "#fff", fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 999, display: "flex", alignItems: "center", gap: 4 }}>
                  <Flame size={12} /> {quickView.tag}
                </span>
              )}
              {quickView.sold_out && <span style={{ position: "absolute", top: 14, left: 14, background: c.borderStrong, color: c.stone, fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 999 }}>SOLD OUT</span>}
              {!quickView.photo_url && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}><span className="mono" style={{ color: c.stone, fontSize: 12 }}>[ photo: {quickView.name} ]</span></div>}
            </div>

            <div style={{ padding: 22 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 10 }}>
                <h2 className="display" style={{ fontSize: 22, fontWeight: 700 }}>{quickView.name}</h2>
                <span className="mono" style={{ color: c.gold, fontWeight: 700, fontSize: 20, whiteSpace: "nowrap" }}>${Number(quickView.price).toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
                <SpiceDots level={quickView.spice_level} c={c} />
                <div style={{ display: "flex", gap: 6, fontSize: 11, color: c.stone, alignItems: "center" }}><Clock size={12} /> {quickView.prep_time}</div>
              </div>
              <p style={{ fontSize: 14, color: c.stone, lineHeight: 1.5, marginBottom: 22 }}>{quickView.description}</p>

              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
                <span className="mono" style={{ fontSize: 11, color: c.stone }}>QTY</span>
                <div style={{ display: "flex", alignItems: "center", gap: 12, background: c.bg, borderRadius: 999, padding: "8px 16px" }}>
                  <button onClick={() => setModalQty((q) => Math.max(1, q - 1))} style={{ background: "none", border: "none", color: c.cream, cursor: "pointer" }}><Minus size={16} /></button>
                  <span className="mono" style={{ fontSize: 15, width: 20, textAlign: "center" }}>{modalQty}</span>
                  <button onClick={() => setModalQty((q) => q + 1)} style={{ background: "none", border: "none", color: c.cream, cursor: "pointer" }}><Plus size={16} /></button>
                </div>
              </div>

              <button
                disabled={quickView.sold_out}
                onClick={(e) => { addToOrder(quickView, modalQty); burstFromButton(e.currentTarget, quickView); setQuickView(null); }}
                style={{ width: "100%", background: quickView.sold_out ? c.borderStrong : c.red, color: "#fff", border: "none", padding: "15px", borderRadius: 12, fontWeight: 700, fontSize: 14, cursor: quickView.sold_out ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
              >
                <ShoppingCart size={16} /> {quickView.sold_out ? "SOLD OUT" : `Add ${modalQty} to Order — $${(Number(quickView.price) * modalQty).toFixed(2)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {fullMenuOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 70, display: "flex", alignItems: "flex-end" }} onClick={() => setFullMenuOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: c.card, borderRadius: "20px 20px 0 0", width: "100%", maxHeight: "88vh", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px 14px", borderBottom: `1px solid ${c.border}`, flexShrink: 0 }}>
              <h2 className="display" style={{ fontSize: 19, fontWeight: 700 }}>Full Menu</h2>
              <button onClick={() => setFullMenuOpen(false)} style={{ background: "rgba(120,120,120,0.15)", border: "none", borderRadius: "50%", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><X size={16} color={c.stone} /></button>
            </div>
            <div style={{ overflowY: "auto", padding: "4px 20px 24px" }}>
              {menu.map((item) => (
                <div key={item.id} onClick={() => { setFullMenuOpen(false); setQuickView(item); setModalQty(1); }} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0", borderBottom: `1px solid ${c.border}`, cursor: "pointer", opacity: item.sold_out ? 0.5 : 1 }}>
                  <div className="checker" style={{ width: 56, height: 56, borderRadius: 10, flexShrink: 0, backgroundImage: item.photo_url ? `url(${item.photo_url})` : undefined, backgroundSize: "cover", backgroundPosition: "center" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: c.cream, marginBottom: 2 }}>{item.name}</div>
                    <div style={{ fontSize: 12, color: c.stone, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.description}</div>
                  </div>
                  <span className="mono" style={{ color: c.gold, fontWeight: 700, fontSize: 14, flexShrink: 0 }}>{item.sold_out ? "SOLD OUT" : `$${Number(item.price).toFixed(2)}`}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {menuBrowserOpen && (
        <div style={{ position: "fixed", inset: 0, background: c.bg, zIndex: 70, overflowY: "auto" }}>
          <div style={{ position: "sticky", top: 0, background: c.bg, borderBottom: `1px solid ${c.border}`, padding: "16px 20px", zIndex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <h2 className="display" style={{ fontSize: 20, fontWeight: 700 }}>Full Menu</h2>
              <button onClick={() => setMenuBrowserOpen(false)} style={{ background: "rgba(120,120,120,0.15)", border: "none", borderRadius: "50%", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><X size={16} color={c.stone} /></button>
            </div>
            <div className="scrollx" style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
              <button onClick={() => setActiveCategory("all")} style={categoryPillStyle(activeCategory === "all")}>ALL ITEMS</button>
              {(categories || []).map((cat) => (
                <button key={cat.id} onClick={() => setActiveCategory(cat.id)} style={categoryPillStyle(activeCategory === cat.id)}>{(cat.name || "").toUpperCase()}</button>
              ))}
            </div>
            {activeCategory !== "all" && (categories || []).find((cat) => cat.id === activeCategory)?.caption && (
              <p style={{ fontSize: 12, color: c.stone, marginTop: 10, marginBottom: 0 }}>{(categories || []).find((cat) => cat.id === activeCategory).caption}</p>
            )}
          </div>
          <div style={{ padding: "18px 20px 32px" }}>
            {(() => {
              const filtered = activeCategory === "all" ? menu : menu.filter((item) => item.category_id === activeCategory);
              if (filtered.length === 0) return <p style={{ fontSize: 12, color: c.stone, textAlign: "center", padding: 30 }}>No items in this category yet.</p>;
              return (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 14 }}>
                  {filtered.map((item, i) => renderCard(item, i))}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {aboutOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={() => setAboutOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: c.card, borderRadius: 16, padding: 26, maxWidth: 420, width: "100%", maxHeight: "80vh", overflowY: "auto", border: `1px solid ${c.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h2 className="display" style={{ fontSize: 19, fontWeight: 700 }}>About {truck.name}</h2>
              <button onClick={() => setAboutOpen(false)} style={{ background: "rgba(120,120,120,0.15)", border: "none", borderRadius: "50%", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}><X size={16} color={c.stone} /></button>
            </div>
            <p style={{ fontSize: 14, color: c.stone, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{truck.about_text || "More about us coming soon."}</p>
          </div>
        </div>
      )}

      <ChatWidget c={c} truckSlug={truck.slug} demoMode={demoMode} bottomOffset={cartCount > 0 && !checkoutOpen ? 70 : 16} />
    </div>
  );
}

/* ============================= CHAT WIDGET ============================= */
function ChatWidget({ c, truckSlug, bottomOffset }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([{ role: "assistant", text: "Hey! Ask me about the menu, spice levels, hours, or catering." }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [messages, loading]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const nextMessages = [...messages, { role: "user", text }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    try {
      const data = await fn("chat-assistant", { truck_slug: truckSlug, messages: nextMessages.slice(1) });
      setMessages((prev) => [...prev, { role: "assistant", text: data.reply || "Sorry, I didn't catch that." }]);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", text: "Having trouble connecting — try calling us instead." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} style={{ position: "fixed", right: 16, bottom: bottomOffset, zIndex: 55, background: c.gold, color: "#1A1210", border: "none", width: 52, height: 52, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 14px rgba(0,0,0,0.4)", cursor: "pointer" }}>
          <MessageCircle size={22} />
        </button>
      )}
      {open && (
        <div style={{ position: "fixed", right: 16, bottom: bottomOffset, zIndex: 55, width: "min(320px, calc(100vw - 32px))", height: 420, background: c.card, border: `1px solid #2A2420`, borderRadius: 16, display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 8px 30px rgba(0,0,0,0.5)" }}>
          <div style={{ padding: "12px 14px", borderBottom: `1px solid #2A2420`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: c.gold }}>Ask the Truck</span>
            <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: c.stone, cursor: "pointer" }}><X size={16} /></button>
          </div>
          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", background: m.role === "user" ? c.gold : c.bg, color: m.role === "user" ? "#1A1210" : c.cream, borderRadius: 10, padding: "8px 11px", fontSize: 12.5, maxWidth: "85%", lineHeight: 1.4, border: m.role === "user" ? "none" : `1px solid #2A2420` }}>
                {m.text}
              </div>
            ))}
            {loading && <div style={{ alignSelf: "flex-start", color: c.stone, fontSize: 11 }} className="mono">typing…</div>}
          </div>
          <div style={{ display: "flex", gap: 6, padding: 10, borderTop: `1px solid #2A2420` }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Ask about spice, hours, catering…" style={{ flex: 1, background: c.bg, border: `1px solid #2A2420`, borderRadius: 999, padding: "8px 12px", color: c.cream, fontSize: 12 }} />
            <button onClick={send} disabled={loading} style={{ background: c.gold, border: "none", borderRadius: "50%", width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
              <Send size={14} color="#1A1210" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/* ============================= OWNER DASHBOARD ============================= */
function OwnerDashboard({ c: cIn, data, session, setSession, goSite }) {
  // Dashboard chrome always uses the VendorGrub brand teal, regardless of
  // the truck's own storefront colors -- keeps every truck's control panel
  // visually consistent even though their public sites all look different.
  const c = { ...cIn, gold: BRAND.teal };
  const [role, setRole] = useState(null); // 'admin' | 'owner' | null (checking)
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    if (session) { setRestoring(false); return; }
    (async () => {
      const restored = await restoreSession();
      if (restored) setSession(restored);
      setRestoring(false);
    })();
  }, []);

  useEffect(() => {
    if (!session) return;
    (async () => {
      const res = await authedRest(`admins?auth_user_id=eq.${session.userId}&select=auth_user_id`, { token: session.access_token });
      const rows = res.ok ? await res.json() : [];
      setRole(rows.length > 0 ? "admin" : "owner");
    })();
  }, [session]);

  const logout = () => { clearSession(); setSession(null); };

  if (restoring) return <div style={{ background: c.bg, color: c.stone, minHeight: "100vh" }} />;
  if (!session) return <LoginScreen c={c} onLogin={setSession} goSite={goSite} />;
  if (role === null) return <div style={{ background: c.bg, color: c.stone, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>Checking access…</div>;
  return <Dashboard c={c} data={data} session={session} onLogout={logout} goSite={goSite} role={role} />;
}

function LoginScreen({ c, onLogin, goSite }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const login = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error_description || json.msg || "Login failed");
      const sess = { access_token: json.access_token, refresh_token: json.refresh_token, expires_at: Date.now() + (json.expires_in || 3600) * 1000, email, userId: json.user?.id };
      saveSession(sess);
      onLogin(sess);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ background: c.bg, color: c.cream, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', system-ui, sans-serif", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 320 }}>
        <button onClick={goSite} style={{ background: "none", border: "none", color: c.stone, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, marginBottom: 20 }}>View Website →</button>
        <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Owner Login</h2>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" style={{ width: "100%", background: c.card, border: `1px solid #2A2420`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginBottom: 10, fontSize: 14 }} />
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" style={{ width: "100%", background: c.card, border: `1px solid #2A2420`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginBottom: 14, fontSize: 14 }} />
        {error && <p style={{ color: c.red, fontSize: 12, marginBottom: 12 }}>{error}</p>}
        <button onClick={login} disabled={loading} style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "12px", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <LogIn size={14} /> {loading ? "Signing in…" : "Sign In"}
        </button>
      </div>
    </div>
  );
}

/* ============================= ADMIN HOME (/admin — official dev entry point, not tied to any truck) ============================= */
function AdminHome() {
  const b = BRAND;
  const [session, setSession] = useState(null);
  const [role, setRole] = useState(null);
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    (async () => {
      const restored = await restoreSession();
      if (restored) setSession(restored);
      setRestoring(false);
    })();
  }, []);

  useEffect(() => {
    if (!session) return;
    (async () => {
      const res = await authedRest(`admins?auth_user_id=eq.${session.userId}&select=auth_user_id`, { token: session.access_token });
      const rows = res.ok ? await res.json() : [];
      setRole(rows.length > 0 ? "admin" : "not_admin");
    })();
  }, [session]);

  const logout = () => { clearSession(); setSession(null); };

  if (restoring) return <div style={{ background: b.bg, color: b.stone, minHeight: "100vh" }} />;

  if (!session) {
    return (
      <div style={{ background: b.bg, color: b.white, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui", padding: 20 }}>
        <div style={{ width: "100%", maxWidth: 320 }}>
          <img src="/vendorgrub-logo.png" alt="VendorGrub" style={{ height: 28, marginBottom: 20 }} />
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Developer Login</h2>
          <p style={{ fontSize: 12, color: b.stone, marginBottom: 20 }}>Not for truck owners — see <a href="/login" style={{ color: b.teal }}>Owner Login</a> instead.</p>
          <AdminLoginForm b={b} onLogin={setSession} />
        </div>
      </div>
    );
  }

  if (role === null) return <div style={{ background: b.bg, color: b.stone, minHeight: "100vh" }} />;

  if (role === "not_admin") {
    return (
      <div style={{ background: b.bg, color: b.white, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, textAlign: "center" }}>
        <div>
          <p style={{ fontSize: 13, color: b.stone, marginBottom: 12 }}>This account isn't a developer/admin account.</p>
          <a href="/login" style={{ color: b.teal, fontSize: 13 }}>Go to Owner Login →</a>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: b.bg, color: b.white, minHeight: "100vh", fontFamily: "system-ui" }}>
      <nav style={{ position: "sticky", top: 0, background: "rgba(10,10,10,0.95)", borderBottom: `1px solid ${b.border}`, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <img src="/vendorgrub-logo.png" alt="VendorGrub" style={{ height: 22 }} />
        <span style={{ fontSize: 12, color: b.teal }}>Developer Dashboard</span>
        <button onClick={logout} style={{ background: "none", border: "none", color: b.stone, cursor: "pointer" }}><LogOut size={16} /></button>
      </nav>
      <TrucksManager c={{ ...COLORS_FALLBACK, bg: b.bg, card: b.card, gold: b.teal, red: "#E5484D", green: "#4CA466" }} session={session} currentTruckId={null} />
    </div>
  );
}

function AdminLoginForm({ b, onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const login = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error_description || json.msg || "Login failed");
      const sess = { access_token: json.access_token, refresh_token: json.refresh_token, expires_at: Date.now() + (json.expires_in || 3600) * 1000, email, userId: json.user?.id };
      saveSession(sess);
      onLogin(sess);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" style={{ width: "100%", background: "rgba(47,191,212,0.07)", border: `1.5px solid ${b.teal}99`, backdropFilter: "blur(6px)", borderRadius: 999, padding: "10px 12px", color: b.white, marginBottom: 10, fontSize: 14 }} />
      <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" style={{ width: "100%", background: "rgba(47,191,212,0.07)", border: `1.5px solid ${b.teal}99`, backdropFilter: "blur(6px)", borderRadius: 999, padding: "10px 12px", color: b.white, marginBottom: 14, fontSize: 14 }} />
      {error && <p style={{ color: "#E5484D", fontSize: 12, marginBottom: 12 }}>{error}</p>}
      <button onClick={login} disabled={loading} style={{ width: "100%", background: b.teal, color: "#0A0A0A", border: "none", padding: "12px", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
        {loading ? "Signing in…" : "Sign In"}
      </button>
    </>
  );
}

/* ============================= OWNER LOGIN (/login — truck-agnostic, finds your truck for you) ============================= */
function OwnerLogin() {
  const b = BRAND;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const login = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error_description || json.msg || "Login failed");
      const token = json.access_token;

      // Find the truck this account owns
      const truckRes = await rest(`trucks?owner_auth_user_id=eq.${json.user?.id}&select=slug`, { token });
      const rows = truckRes.ok ? await truckRes.json() : [];
      if (rows.length === 0) {
        setError("No truck is linked to this account yet. If you're the developer/admin, use Admin Login instead.");
        setLoading(false);
        return;
      }
      saveSession({ access_token: json.access_token, refresh_token: json.refresh_token, expires_at: Date.now() + (json.expires_in || 3600) * 1000, email, userId: json.user?.id });
      window.location.href = `/${rows[0].slug}/manage`;
    } catch (e) {
      setError(String(e.message || e));
      setLoading(false);
    }
  };

  return (
    <div style={{ background: b.bg, color: b.white, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 320 }}>
        <img src="/vendorgrub-logo.png" alt="VendorGrub" style={{ height: 28, marginBottom: 20 }} />
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Owner Login</h2>
        <p style={{ fontSize: 12, color: b.stone, marginBottom: 20 }}>We'll take you straight to your truck's dashboard.</p>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" style={{ width: "100%", background: "rgba(47,191,212,0.07)", border: `1.5px solid ${b.teal}99`, backdropFilter: "blur(6px)", borderRadius: 999, padding: "10px 12px", color: b.white, marginBottom: 10, fontSize: 14 }} />
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" style={{ width: "100%", background: "rgba(47,191,212,0.07)", border: `1.5px solid ${b.teal}99`, backdropFilter: "blur(6px)", borderRadius: 999, padding: "10px 12px", color: b.white, marginBottom: 14, fontSize: 14 }} />
        {error && <p style={{ color: "#E5484D", fontSize: 12, marginBottom: 12 }}>{error}</p>}
        <button onClick={login} disabled={loading} style={{ width: "100%", background: b.teal, color: "#0A0A0A", border: "none", padding: "12px", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          {loading ? "Signing in…" : "Sign In"}
        </button>
      </div>
    </div>
  );
}

// Renders the real CustomerSite — not a lookalike — inside a device frame,
// with unsaved Truck Profile edits layered over the real saved data. It
// can never visually drift from the actual site because it is the actual
// site. demoMode keeps taps (including "Add to Order") safe: real cart and
// checkout UI work, nothing is ever actually submitted.
// Renders the real CustomerSite component at phone width inside a mock
// iPhone bezel -- not an iframe of the deployed site, the actual live
// component with the owner's current (and unsaved draft) data, so editing
// elsewhere on this page updates what's "on screen" here instantly.
function LivePreviewFrame({ truck, theme, location, menu, faqs, categories, draft }) {
  const previewTruck = draft ? { ...truck, name: draft.name, tagline: draft.tagline, subline: draft.subline, phone: draft.phone } : truck;
  const previewTheme = draft ? { ...theme, font_key: draft.fontKey, hero_photo_url: draft.heroPreview } : theme;
  const previewColors = buildColors(previewTheme);
  const previewData = { truck: previewTruck, theme: previewTheme, location, menu, faqs, categories };

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, padding: "0 2px" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "#8B8B8B", letterSpacing: 1 }}>
          <span className="hud-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "#4CA466", display: "inline-block" }} />
          MOBILE PREVIEW
        </span>
        <a href={`/${truck.slug}`} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#2FBFD4", textDecoration: "none", fontWeight: 600 }}>View full size ↗</a>
      </div>
      <style>{`@keyframes livePreviewPulse { 0%,100%{opacity:1} 50%{opacity:0.35} } .hud-dot { animation: livePreviewPulse 1.6s ease-in-out infinite; }`}</style>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <div style={{ width: 300, background: "#0A0A0A", borderRadius: 46, padding: "16px 10px", boxShadow: "0 24px 60px rgba(0,0,0,0.5), inset 0 0 0 2px #2A2A2A", position: "relative" }}>
          <div style={{ position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", width: 120, height: 26, background: "#000", borderRadius: 14, zIndex: 2 }} />
          <div style={{ borderRadius: 32, overflow: "hidden", height: 600, background: "#000" }}>
            <div style={{ height: "100%", overflowY: "auto" }}>
              <CustomerSite c={previewColors} data={previewData} demoMode />
            </div>
          </div>
          <div style={{ position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)", width: 110, height: 4, background: "#3A3A3A", borderRadius: 999 }} />
        </div>
      </div>
    </div>
  );
}

function TruckProfilePanel({ c, truck, theme, session, reload, bare, onDraftChange }) {
  const [name, setName] = useState(truck.name);
  const [tagline, setTagline] = useState(truck.tagline || "");
  const [subline, setSubline] = useState(truck.subline || "");
  const [phone, setPhone] = useState(truck.phone || "");
  const [aboutText, setAboutText] = useState(truck.about_text || "");
  const [fontKey, setFontKey] = useState(theme?.font_key || "kaushan");
  const [heroPreview, setHeroPreview] = useState(theme?.hero_photo_url || null);
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // Reports every keystroke upward so a live preview can render the real
  // storefront with unsaved edits layered on — this panel still owns its
  // own inputs, it's just also broadcasting them.
  useEffect(() => {
    onDraftChange?.({ name, tagline, subline, phone, fontKey, heroPreview });
  }, [name, tagline, subline, phone, fontKey, heroPreview]);

  const save = async (heroFile, overrideFontKey) => {
    setError("");
    setUploading(true);
    let hero_photo_url;
    try {
      if (heroFile) {
        hero_photo_url = await uploadPhoto(heroFile, `trucks/${truck.id}/theme/hero-${Date.now()}.${heroFile.name.split(".").pop()}`, session.access_token);
      }
      const res = await authedFn("owner-profile-update", { slug: truck.slug, name, tagline, subline, phone, about_text: aboutText, font_key: overrideFontKey || fontKey, ...(hero_photo_url ? { hero_photo_url } : {}) }, session.access_token);
      if (res.error) throw new Error(res.error);
      setSaved(true);
      reload?.();
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const selectFont = (key) => {
    setFontKey(key);
    save(null, key);
  };

  const shellStyle = bare
    ? {}
    : { background: c.card, border: `1px solid #2A2420`, borderRadius: 14, padding: 18, marginBottom: 18 };

  return (
    <div style={shellStyle}>
      {!bare && <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>Truck Profile</div>}

      <label style={{ height: 110, borderRadius: 10, marginBottom: 14, cursor: "pointer", overflow: "hidden", position: "relative", background: heroPreview ? `url(${heroPreview}) center/cover` : c.bg, border: `1px dashed #3A322C`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {!heroPreview && <div style={{ textAlign: "center" }}><ImageIcon size={20} color={c.stone} /><div style={{ fontSize: 11, color: c.stone, marginTop: 4 }}>Hero background photo</div></div>}
        {heroPreview && <div style={{ position: "absolute", bottom: 6, right: 6, background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 10, padding: "3px 8px", borderRadius: 999 }}>Change photo</div>}
        <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files[0]; if (f) { setHeroPreview(URL.createObjectURL(f)); save(f); } }} />
      </label>

      <label className="mono" style={{ fontSize: 10, color: c.stone }}>TRUCK NAME</label>
      <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginTop: 6, marginBottom: 14, fontSize: 14 }} />

      <label className="mono" style={{ fontSize: 10, color: c.stone, display: "block", marginBottom: 6 }}>NAME STYLE — scroll to browse, tap to apply</label>
      <div className="scrollx" style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4, marginBottom: 14 }}>
        {Object.entries(NAME_FONTS).map(([key, f]) => (
          <button key={key} onClick={() => selectFont(key)} style={{ flexShrink: 0, background: c.bg, border: `2px solid ${fontKey === key ? c.gold : "#2A2420"}`, borderRadius: 10, padding: "8px 16px", cursor: "pointer" }}>
            <span style={{ fontFamily: f.family, fontSize: 17, color: c.cream, whiteSpace: "nowrap" }}>{name || truck.name}</span>
          </button>
        ))}
      </div>

      <label className="mono" style={{ fontSize: 10, color: c.stone }}>TAGLINE</label>
      <input value={tagline} onChange={(e) => setTagline(e.target.value)} style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginTop: 6, marginBottom: 10, fontSize: 14 }} />
      <label className="mono" style={{ fontSize: 10, color: c.stone }}>PHONE</label>
      <input value={phone} onChange={(e) => setPhone(e.target.value)} style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginTop: 6, marginBottom: 14, fontSize: 14 }} />

      <label className="mono" style={{ fontSize: 10, color: c.stone }}>ABOUT — shown in the "About Vendor" section of your site</label>
      <textarea value={aboutText} onChange={(e) => setAboutText(e.target.value)} rows={4} placeholder="Tell customers your story — how you started, what makes your food different, where you're from…" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginTop: 6, marginBottom: 14, fontSize: 13, fontFamily: "inherit", resize: "vertical" }} />

      {error && <p style={{ color: c.red, fontSize: 11, marginBottom: 8 }}>{error}</p>}
      <button onClick={() => save(null)} disabled={uploading} style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "12px", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
        {uploading ? "Saving…" : saved ? "✓ Saved" : "Save Truck Profile"}
      </button>
    </div>
  );
}

function DeliverySettingsPanel({ c, truck, session, bare }) {
  const [fee, setFee] = useState(truck.delivery_fee ?? 0);
  const [radius, setRadius] = useState(truck.delivery_radius || "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError("");
    setSaving(true);
    const res = await authedFn("set-delivery-settings", { slug: truck.slug, delivery_fee: fee, delivery_radius: radius }, session.access_token);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  return (
    <div style={bare ? {} : { background: c.card, border: `1px solid #2A2420`, borderRadius: 12, padding: 14, marginBottom: 16 }}>
      {!bare && <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Delivery Settings</div>}
      <p style={{ fontSize: 11, color: c.stone, marginBottom: 10 }}>Controls the fee and radius customers see when they choose Delivery at checkout.</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <label className="mono" style={{ fontSize: 10, color: c.stone }}>DELIVERY FEE ($)</label>
          <input type="number" step="0.01" min="0" value={fee} onChange={(e) => setFee(e.target.value)} style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginTop: 4 }} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="mono" style={{ fontSize: 10, color: c.stone }}>RADIUS (e.g. "3 miles")</label>
          <input value={radius} onChange={(e) => setRadius(e.target.value)} placeholder="3 miles" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginTop: 4 }} />
        </div>
      </div>
      {error && <p style={{ color: c.red, fontSize: 11, marginBottom: 8 }}>{error}</p>}
      <button onClick={save} disabled={saving} style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "9px", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
        {saved ? "✓ Saved" : saving ? "Saving…" : "Save Delivery Settings"}
      </button>
    </div>
  );
}

function LoyaltyPanel({ c, truck, session }) {
  const [settings, setSettings] = useState(null);
  const [rewards, setRewards] = useState([]);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pointsPerOrder, setPointsPerOrder] = useState(10);
  const [saved, setSaved] = useState(false);
  const [newReward, setNewReward] = useState({ name: "", points_cost: "", description: "" });
  const [redeemFor, setRedeemFor] = useState(null); // phone of member being redeemed
  const [error, setError] = useState("");

  const authedGet = (path) => authedRest(path, { token: session.access_token }).then((r) => r.json());
  const authedPatch = (path, body) => authedRest(path, { method: "PATCH", token: session.access_token, body: JSON.stringify(body), prefer: "return=representation" });
  const authedPost = (path, body) => authedRest(path, { method: "POST", token: session.access_token, body: JSON.stringify(body), prefer: "return=representation" });
  const authedDelete = (path) => authedRest(path, { method: "DELETE", token: session.access_token, prefer: "return=minimal" });

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [s, r, m] = await Promise.all([
      authedGet(`loyalty_settings?truck_id=eq.${truck.id}&select=*`),
      authedGet(`loyalty_rewards?truck_id=eq.${truck.id}&select=*&order=points_cost`),
      authedGet(`loyalty_customers?truck_id=eq.${truck.id}&select=*&order=points_balance.desc`),
    ]);
    const s0 = s?.[0] || { enabled: false, points_per_order: 10 };
    setSettings(s0);
    setPointsPerOrder(s0.points_per_order);
    setRewards(r || []);
    setMembers(m || []);
    setLoading(false);
  }, [truck.id, session.access_token]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const toggleEnabled = async () => {
    const next = !settings.enabled;
    setSettings((s) => ({ ...s, enabled: next }));
    const res = await authedPatch(`loyalty_settings?truck_id=eq.${truck.id}`, { enabled: next, points_per_order: pointsPerOrder });
    const rows = res.ok ? await res.json().catch(() => []) : [];
    if (!rows || rows.length === 0) {
      await authedPost(`loyalty_settings`, { truck_id: truck.id, enabled: next, points_per_order: pointsPerOrder });
    }
  };

  const savePointsPerOrder = async () => {
    const res = await authedPatch(`loyalty_settings?truck_id=eq.${truck.id}`, { points_per_order: Number(pointsPerOrder) });
    const rows = res.ok ? await res.json().catch(() => []) : [];
    if (!rows || rows.length === 0) {
      await authedPost(`loyalty_settings`, { truck_id: truck.id, enabled: settings?.enabled || false, points_per_order: Number(pointsPerOrder) });
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const addReward = async () => {
    if (!newReward.name.trim() || !newReward.points_cost) return;
    const res = await authedPost(`loyalty_rewards`, { truck_id: truck.id, name: newReward.name.trim(), points_cost: Number(newReward.points_cost), description: newReward.description.trim() });
    if (res.ok) { const [created] = await res.json(); setRewards((prev) => [...prev, created].sort((a, b) => a.points_cost - b.points_cost)); setNewReward({ name: "", points_cost: "", description: "" }); }
  };
  const deleteReward = async (id) => {
    setRewards((prev) => prev.filter((r) => r.id !== id));
    await authedDelete(`loyalty_rewards?id=eq.${id}`);
  };

  const redeem = async (phone, reward) => {
    setError("");
    const res = await authedFn("redeem-loyalty-reward", { slug: truck.slug, phone, reward_id: reward.id }, session.access_token);
    if (res.error) { setError(res.error); return; }
    setMembers((prev) => prev.map((m) => (m.phone === phone ? { ...m, points_balance: res.new_balance } : m)));
    setRedeemFor(null);
  };

  const rewardsUrl = `${window.location.origin}/${truck.slug}/rewards`;

  if (loading) return <p style={{ fontSize: 12, color: c.stone }}>Loading…</p>;

  return (
    <>
      <div style={{ background: c.card, border: `1px solid #2A2420`, borderRadius: 14, padding: 18, marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>Rewards Program</span>
          <button onClick={toggleEnabled} style={{ background: settings.enabled ? c.green : "#3A322C", border: "none", borderRadius: 999, width: 44, height: 24, position: "relative", cursor: "pointer" }}>
            <span style={{ position: "absolute", top: 3, left: settings.enabled ? 23 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
          </button>
        </div>
        <p style={{ fontSize: 11, color: c.stone, marginBottom: 14 }}>{settings.enabled ? "Live — customers see the opt-in checkbox at checkout." : "Off — checkout won't mention rewards."}</p>
        <label className="mono" style={{ fontSize: 10, color: c.stone }}>POINTS PER ORDER</label>
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <input type="number" min="1" value={pointsPerOrder} onChange={(e) => setPointsPerOrder(e.target.value)} style={{ flex: 1, background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 13 }} />
          <button onClick={savePointsPerOrder} style={{ background: c.gold, color: "#1A1210", border: "none", borderRadius: 8, padding: "0 16px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>{saved ? "✓" : "Save"}</button>
        </div>
      </div>

      <div style={{ background: c.card, border: `1px solid #2A2420`, borderRadius: 14, padding: 18, marginBottom: 18, textAlign: "center" }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Share Your Rewards Page</div>
        <div style={{ background: "#fff", borderRadius: 12, padding: 14, display: "inline-block", marginBottom: 10 }}>
          <QRCodeCanvas value={rewardsUrl} size={130} fgColor="#0A0A0A" bgColor="#ffffff" />
        </div>
        <p className="mono" style={{ fontSize: 10, color: c.gold }}>{truck.slug}/rewards</p>
        <p style={{ fontSize: 10, color: c.stone, marginTop: 6 }}>Print this by the window — customers scan to check their points.</p>
      </div>

      <div style={{ marginBottom: 18 }}>
        <span className="mono" style={{ fontSize: 11, letterSpacing: 2, color: c.gold }}>REWARD TIERS</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10, marginBottom: 12 }}>
          {rewards.length === 0 && <p style={{ fontSize: 12, color: c.stone }}>No rewards yet — add one below.</p>}
          {rewards.map((r) => (
            <div key={r.id} style={{ background: c.card, border: `1px solid #2A2420`, borderRadius: 10, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{r.name} <span className="mono" style={{ color: c.gold, fontWeight: 700, fontSize: 12 }}>· {r.points_cost} pts</span></div>
                {r.description && <div style={{ fontSize: 11, color: c.stone, marginTop: 2 }}>{r.description}</div>}
              </div>
              <button onClick={() => deleteReward(r.id)} style={{ background: "none", border: "none", color: c.stone, cursor: "pointer" }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        <div style={{ background: c.card, border: `1px dashed #3A322C`, borderRadius: 10, padding: 12 }}>
          <input value={newReward.name} onChange={(e) => setNewReward((s) => ({ ...s, name: e.target.value }))} placeholder="Reward name (e.g. Free Drink)" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
          <input value={newReward.description} onChange={(e) => setNewReward((s) => ({ ...s, description: e.target.value }))} placeholder="Description (optional)" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
          <input value={newReward.points_cost} onChange={(e) => setNewReward((s) => ({ ...s, points_cost: e.target.value }))} type="number" placeholder="Points cost" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
          <button onClick={addReward} style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "9px", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>+ Add Reward</button>
        </div>
      </div>

      <div>
        <span className="mono" style={{ fontSize: 11, letterSpacing: 2, color: c.gold }}>MEMBERS ({members.length})</span>
        {error && <p style={{ color: c.red, fontSize: 11, margin: "8px 0" }}>{error}</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
          {members.length === 0 && <p style={{ fontSize: 12, color: c.stone }}>No one's opted in yet.</p>}
          {members.map((m) => (
            <div key={m.id} style={{ background: c.card, border: `1px solid #2A2420`, borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{m.name || "Guest"} <span className="mono" style={{ fontSize: 10, color: c.stone }}>{m.phone}</span></div>
                  <div style={{ fontSize: 11, color: c.stone, marginTop: 2 }}>{m.total_orders} order{m.total_orders === 1 ? "" : "s"}</div>
                </div>
                <span className="mono" style={{ color: c.gold, fontWeight: 700, fontSize: 15 }}>{m.points_balance} pts</span>
              </div>
              {redeemFor === m.phone ? (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  {rewards.filter((r) => r.points_cost <= m.points_balance).map((r) => (
                    <button key={r.id} onClick={() => redeem(m.phone, r)} style={{ background: c.bg, border: `1px solid ${c.gold}`, color: c.gold, borderRadius: 8, padding: "8px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Redeem: {r.name} ({r.points_cost} pts)</button>
                  ))}
                  {rewards.filter((r) => r.points_cost <= m.points_balance).length === 0 && <p style={{ fontSize: 11, color: c.stone }}>Not enough points for any reward yet.</p>}
                  <button onClick={() => setRedeemFor(null)} style={{ background: "none", border: "1px solid #2A2420", color: c.stone, borderRadius: 8, padding: "6px", fontSize: 11, cursor: "pointer" }}>Cancel</button>
                </div>
              ) : (
                <button onClick={() => setRedeemFor(m.phone)} style={{ marginTop: 8, background: "none", border: "1px solid #2A2420", color: c.stone, borderRadius: 8, padding: "6px 12px", fontSize: 11, cursor: "pointer" }}>Redeem a reward</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// Collapsed-by-default settings section. The owner dashboard is used by
// people setting up a food truck, not operators of a CMS — showing every
// control at once reads as work. Each section stays shut until asked for,
// with a one-line summary so its current state is still visible closed.
function Collapsible({ c, title, summary, icon, defaultOpen = false, open: controlledOpen, onToggle, children }) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const toggle = () => (isControlled ? onToggle?.(!open) : setInternalOpen((o) => !o));

  return (
    <div
      style={{
        background: `${c.card}E6`, backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
        border: `1px solid ${c.border}`, borderRadius: 20, marginBottom: 14, overflow: "hidden",
        boxShadow: c.mode === "light" ? "0 10px 28px rgba(30,15,25,0.08)" : "0 10px 28px rgba(0,0,0,0.35)",
      }}
    >
      <button
        onClick={toggle}
        aria-expanded={open}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, background: "none", border: "none", color: c.cream, padding: 16, cursor: "pointer", textAlign: "left" }}
      >
        {icon && (
          <span style={{ flexShrink: 0, width: 38, height: 38, borderRadius: "50%", background: `${c.gold}1F`, display: "flex", alignItems: "center", justifyContent: "center", color: c.gold }}>
            {icon}
          </span>
        )}
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontWeight: 700, fontSize: 13.5 }}>{title}</span>
          {summary && <span style={{ display: "block", fontSize: 11, color: c.stone, marginTop: 2 }}>{summary}</span>}
        </span>
        <ChevronDown size={17} color={c.stone} style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.18s ease" }} />
      </button>
      {open && <div style={{ padding: "0 16px 16px" }}>{children}</div>}
    </div>
  );
}

// Turns "here are all your settings" into "here is your next step". Hides
// itself once the truck is actually ready, so it guides setup without
// becoming permanent clutter.
// The three things a truck genuinely needs before customers can find and
// order from it. Everything else is polish, not a blocker -- conflating
// the two used to mean the dashboard kept nudging "still setting up" even
// after an owner was, functionally, open for business.
const REQUIRED_SETUP_STEPS = [
  { label: "Add your first menu item", done: (menu, truck, theme, location) => (menu?.length || 0) > 0, tab: "menu" },
  { label: "Pin where you park", done: (menu, truck, theme, location) => location?.lat != null && location?.lng != null, tab: "home" },
  { label: "Switch yourself to Open", done: (menu, truck, theme, location) => location?.status === "OPEN", tab: "home" },
];
const OPTIONAL_SETUP_STEPS = [
  { label: "Upload a photo for your header", done: (menu, truck, theme, location) => !!theme?.hero_photo_url, tab: "website" },
  { label: "Tell customers your story", done: (menu, truck, theme, location) => !!truck?.about_text, tab: "website" },
];

function SetupChecklist({ c, truck, theme, menu, location, onGo }) {
  const resolve = (list) => list.map((s) => ({ ...s, done: s.done(menu, truck, theme, location) }));
  const required = resolve(REQUIRED_SETUP_STEPS);
  const optional = resolve(OPTIONAL_SETUP_STEPS);
  const steps = [...required, ...optional];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;

  const readyToOpen = required.every((s) => s.done);
  const glass = { background: hexAlpha(c.card, 0.55), backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)" };

  if (readyToOpen) {
    return (
      <div style={{ ...glass, border: `1px solid ${hexAlpha(c.green, 0.45)}`, borderRadius: 18, padding: 16, marginBottom: 16, boxShadow: `0 8px 30px rgba(0,0,0,0.3), inset 0 1px 0 ${hexAlpha(c.cream, 0.05)}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 17 }}>🚀</span>
          <span style={{ fontWeight: 700, fontSize: 13.5 }}>You're ready to open</span>
        </div>
        <p style={{ fontSize: 11.5, color: c.stone, marginBottom: 12 }}>Customers can find and order from you right now. A couple of extras whenever you have time:</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {optional.map((s) => (
            <button
              key={s.label}
              onClick={() => onGo(s.tab)}
              style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", color: s.done ? c.stone : c.cream }}
            >
              {s.done
                ? <CheckCircle2 size={15} color={c.green} style={{ flexShrink: 0 }} />
                : <Circle size={15} color="#3A322C" style={{ flexShrink: 0 }} />}
              <span style={{ fontSize: 12.5, textDecoration: s.done ? "line-through" : "none" }}>{s.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const next = steps.find((s) => !s.done);
  return (
    <div style={{ ...glass, border: `1px solid ${hexAlpha(c.gold, 0.35)}`, borderRadius: 18, padding: 16, marginBottom: 16, boxShadow: `0 8px 30px rgba(0,0,0,0.3), inset 0 1px 0 ${hexAlpha(c.cream, 0.05)}` }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>Finish setting up</span>
        <span className="mono" style={{ fontSize: 11, color: c.stone }}>{done} of {steps.length}</span>
      </div>
      <div style={{ background: "#2A2420", borderRadius: 999, height: 5, overflow: "hidden", marginBottom: 12 }}>
        <div style={{ background: c.gold, height: "100%", width: `${(done / steps.length) * 100}%`, transition: "width 0.3s ease" }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {steps.map((s) => (
          <button
            key={s.label}
            onClick={() => onGo(s.tab)}
            style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", color: s.done ? c.stone : c.cream }}
          >
            {s.done
              ? <CheckCircle2 size={15} color={c.green} style={{ flexShrink: 0 }} />
              : <Circle size={15} color={s === next ? c.gold : "#3A322C"} style={{ flexShrink: 0 }} />}
            <span style={{ fontSize: 12.5, textDecoration: s.done ? "line-through" : "none", fontWeight: s === next ? 600 : 400 }}>{s.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Owner-facing color editor. Previously admin-only, which left real truck
// owners with no way to adjust their own background/accent/text colors
// after picking a template at onboarding.
function ThemeColorsPanel({ c, truck, theme, session, reload }) {
  const FIELDS = [
    ["color_bg", "Page background", "The main background behind everything."],
    ["color_card", "Card surface", "Menu cards and panels sitting on the background."],
    ["color_gold", "Primary accent", "Headings, prices, Call and Catering buttons."],
    ["color_red", "Secondary accent", "Add to Order buttons and item tags."],
    // Only templates built around a glow/motion look (currently Neon Pulse)
    // use a 3rd accent — showing it for everyone else would be a control
    // with no visible effect, which is exactly the clutter we're avoiding.
    ...(theme?.color_accent2 ? [["color_accent2", "Glow accent", "The second glow color behind your hero and menu cards."]] : []),
    ["color_cream", "Text", "Item names and body headings."],
    ["color_stone", "Muted text", "Descriptions and secondary details."],
  ];
  const seed = () => FIELDS.reduce((acc, [k]) => ({ ...acc, [k]: theme?.[k] || COLORS_FALLBACK[k.replace("color_", "")] || "#000000" }), {});
  const [draft, setDraft] = useState(seed);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      const res = await authedRest(`truck_theme?truck_id=eq.${truck.id}`, {
        method: "PATCH", token: session.access_token,
        body: JSON.stringify(draft), prefer: "return=representation",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.message || `Could not save colors (${res.status}).`);
        return;
      }
      // RLS can block a write and still return 200 with an empty array —
      // that's the exact failure mode that made this panel look like it
      // worked while silently changing nothing.
      const rows = await res.json().catch(() => null);
      if (Array.isArray(rows) && rows.length === 0) {
        setError("Nothing was saved — you may not have permission to edit this truck. Contact support.");
        return;
      }
      setSaved(true);
      reload?.();
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError(`Could not save colors — ${e.message}.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {/* Live preview so the effect of a color is obvious before saving */}
      <div style={{ background: draft.color_bg, border: `1px solid #2A2420`, borderRadius: 10, padding: 12, marginBottom: 14 }}>
        <div style={{ color: draft.color_gold, fontSize: 10, letterSpacing: 2, fontWeight: 700, marginBottom: 6 }}>PREVIEW</div>
        <div style={{ background: draft.color_card, borderRadius: 8, padding: 10 }}>
          <div style={{ color: draft.color_cream, fontWeight: 700, fontSize: 13 }}>Al Pastor Taco</div>
          <div style={{ color: draft.color_stone, fontSize: 11, margin: "2px 0 8px" }}>Marinated pork, pineapple, cilantro</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: draft.color_gold, fontWeight: 700, fontSize: 14 }}>$3.75</span>
            <span style={{ marginLeft: "auto", background: draft.color_red, color: "#fff", fontSize: 10, fontWeight: 700, padding: "6px 12px", borderRadius: 8 }}>ADD TO ORDER</span>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {FIELDS.map(([key, label, help]) => (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input
              type="color" value={draft[key]}
              onChange={(e) => setDraft((s) => ({ ...s, [key]: e.target.value }))}
              aria-label={label}
              style={{ width: 40, height: 32, border: "none", background: "none", cursor: "pointer", flexShrink: 0, padding: 0 }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</div>
              <div style={{ fontSize: 10, color: c.stone, lineHeight: 1.3 }}>{help}</div>
            </div>
            <span className="mono" style={{ fontSize: 10, color: c.stone, flexShrink: 0 }}>{draft[key]}</span>
          </div>
        ))}
      </div>

      {error && <p style={{ color: c.red, fontSize: 11, marginTop: 10 }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button onClick={() => setDraft(seed())} style={{ flex: 1, background: "none", border: `1px solid #2A2420`, color: c.stone, padding: "11px", borderRadius: 10, fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Undo changes</button>
        <button onClick={save} disabled={saving} style={{ flex: 2, background: c.gold, color: "#1A1210", border: "none", padding: "11px", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer", opacity: saving ? 0.6 : 1 }}>
          {saving ? "Saving…" : saved ? "✓ Saved — live on your site" : "Save Colors"}
        </button>
      </div>
    </div>
  );
}

function TemplateSwitcher({ c, truck, theme, session, reload }) {
  const [templates, setTemplates] = useState(null);
  const [applying, setApplying] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    rest(`site_templates?select=*&order=sort_order`).then((r) => r.json()).then(setTemplates);
  }, []);

  const authedPatch = (path, body) => authedRest(path, { method: "PATCH", token: session.access_token, body: JSON.stringify(body), prefer: "return=representation" });

  const apply = async (t) => {
    setApplying(t.key);
    setError("");
    try {
      const res = await authedPatch(`truck_theme?truck_id=eq.${truck.id}`, {
        color_bg: t.color_bg, color_card: t.color_card, color_gold: t.color_gold,
        color_red: t.color_red, color_cream: t.color_cream, color_stone: t.color_stone,
        color_accent2: t.color_accent2 || null,
        mode: t.mode, menu_layout: t.menu_layout, heading_font: t.heading_font, decoration: t.decoration,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.message || `Could not switch template (${res.status}).`);
        return;
      }
      // RLS can block a write and still return 200 with an empty array —
      // that would otherwise look like a successful switch that did nothing.
      const rows = await res.json().catch(() => null);
      if (Array.isArray(rows) && rows.length === 0) {
        setError("Nothing was changed — you may not have permission to edit this truck. Contact support.");
        return;
      }
      reload?.();
    } catch (e) {
      setError(`Could not switch template — ${e.message}.`);
    } finally {
      setApplying("");
    }
  };

  // Same layout thumbnails the owner chose from at signup, so switching
  // later is recognisably the same decision rather than a new vocabulary.
  const isActive = (t) => theme && t.color_bg === theme.color_bg && t.color_gold === theme.color_gold;

  return (
    <div>
      <p style={{ fontSize: 11.5, color: c.stone, marginBottom: 12, lineHeight: 1.5 }}>Pick a new look. This replaces your colors, layout and lettering in one tap — you can still fine-tune afterwards.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {!templates && <p style={{ fontSize: 12, color: c.stone }}>Loading designs…</p>}
        {templates?.map((t) => (
          <button
            key={t.key}
            onClick={() => apply(t)}
            disabled={!!applying}
            style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: 12, alignItems: "center", textAlign: "left", background: isActive(t) ? `${c.gold}18` : "transparent", border: `2px solid ${isActive(t) ? c.gold : "#2A2420"}`, borderRadius: 12, padding: 10, cursor: applying ? "wait" : "pointer" }}
          >
            <div style={{ width: 72, height: 72, overflow: "hidden", borderRadius: 9, flexShrink: 0 }}>
              <div style={{ transform: "scale(0.857)", transformOrigin: "top left" }}><TemplateThumb t={t} /></div>
            </div>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", color: c.cream, fontWeight: 700, fontSize: 13 }}>
                {applying === t.key ? "Applying…" : t.name}
                {isActive(t) && !applying && <span style={{ color: c.gold, fontSize: 10, fontWeight: 700, marginLeft: 6 }}>· IN USE</span>}
              </span>
              <span style={{ display: "block", color: c.stone, fontSize: 11, marginTop: 2, lineHeight: 1.35 }}>{t.description}</span>
            </span>
          </button>
        ))}
      </div>
      {error && <p style={{ color: c.red, fontSize: 11, marginTop: 10 }}>{error}</p>}
    </div>
  );
}

// Change password while logged in -- Supabase Auth trusts a valid session's
// bearer token for this, so no current-password re-entry or edge function
// is needed, just a direct PUT to the auth API (same pattern as the rest
// of the app's direct-to-Supabase calls).
function AccountPanel({ c, session, bare }) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const changePassword = async () => {
    setError("");
    if (newPassword.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (newPassword !== confirmPassword) { setError("Passwords don't match."); return; }
    setSaving(true);
    try {
      const token = await getFreshToken(session.access_token);
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: newPassword }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.message || err.msg || `Could not change password (${res.status}).`);
        return;
      }
      setSaved(true);
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError(`Could not change password — ${e.message}. Check your connection and try again.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={bare ? {} : { background: c.card, border: `1px solid #2A2420`, borderRadius: 14, padding: 18, marginBottom: 18 }}>
      {!bare && <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Account</div>}
      <label className="mono" style={{ fontSize: 10, color: c.stone }}>LOGIN EMAIL</label>
      <div style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 10, padding: "10px 12px", color: c.stone, marginTop: 6, marginBottom: 16, fontSize: 14 }}>{session.email}</div>

      <label className="mono" style={{ fontSize: 10, color: c.stone }}>NEW PASSWORD</label>
      <input
        type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
        placeholder="At least 8 characters"
        style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginTop: 6, marginBottom: 10, fontSize: 14 }}
      />
      <label className="mono" style={{ fontSize: 10, color: c.stone }}>CONFIRM NEW PASSWORD</label>
      <input
        type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
        placeholder="Retype the new password"
        style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginTop: 6, marginBottom: 14, fontSize: 14 }}
      />
      {error && <p style={{ color: c.red, fontSize: 11, marginBottom: 8 }}>{error}</p>}
      <button
        onClick={changePassword} disabled={saving || !newPassword}
        style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "12px", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer", opacity: (saving || !newPassword) ? 0.6 : 1 }}
      >
        {saving ? "Saving…" : saved ? "✓ Password updated" : "Change Password"}
      </button>
    </div>
  );
}

function KitchenPinPanel({ c, truck, session, bare }) {
  const [pin, setPin] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError("");
    if (!/^\d{4,6}$/.test(pin)) { setError("PIN must be 4-6 digits"); return; }
    setSaving(true);
    const res = await authedFn("set-kitchen-pin", { slug: truck.slug, pin }, session.access_token);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  return (
    <div style={bare ? {} : { background: c.card, border: `1px solid #2A2420`, borderRadius: 14, padding: 18, marginBottom: 18 }}>
      {!bare && <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Kitchen Access PIN</div>}
      <p style={{ fontSize: 11, color: c.stone, marginBottom: 12 }}>
        Give this PIN to whoever's cooking. They enter it at <span className="mono">/{truck.slug}/kitchen</span> to see incoming order tickets — no login needed.
      </p>
      <input
        value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        placeholder="4-6 digit PIN" inputMode="numeric"
        style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginBottom: 10, fontSize: 14, letterSpacing: 2 }}
      />
      {error && <p style={{ color: c.red, fontSize: 11, marginBottom: 8 }}>{error}</p>}
      <button onClick={save} disabled={saving} style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "10px", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
        {saved ? "✓ PIN Set" : saving ? "Saving…" : "Set Kitchen PIN"}
      </button>
    </div>
  );
}

// Lets the owner ring up a walk-up order themselves: tap items off their own
// menu, name the customer, submit — it lands in the same orders table (and
// Live Orders queue / kitchen screen) as an online order would.
// Categories are whatever the owner already set up in Menu -- same list
// customers browse by, now also used to keep a big menu from turning into
// a wall of items when someone's mid-rush at the window.
// Audience is whoever has an email on file from an order (online checkout
// or the optional field on Take Order) minus anyone who's unsubscribed --
// no separate contact list to manage, it's just derived from real orders.
function MarketingPanel({ c, truck, audienceCount, campaigns, session, onSent }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const send = async () => {
    if (!subject.trim() || !body.trim()) { setError("Subject and message are both required."); return; }
    setSending(true);
    setError("");
    setResult(null);
    try {
      const res = await authedFn("send-campaign", { slug: truck.slug, subject: subject.trim(), body: body.trim() }, session.access_token);
      if (res.error) { setError(res.error); return; }
      setResult(`Sent to ${res.sent} of ${res.attempted} customers.`);
      setSubject("");
      setBody("");
      onSent?.();
    } catch (e) {
      setError(`Could not send — ${e.message}.`);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div style={{ background: c.card, border: `1px solid #2A2420`, borderRadius: 14, padding: 16, marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700 }}>New Campaign</h3>
          <span className="mono" style={{ fontSize: 11, color: c.gold }}>{audienceCount} customer{audienceCount === 1 ? "" : "s"}</span>
        </div>
        {audienceCount === 0 ? (
          <p style={{ fontSize: 12, color: c.stone }}>No customers with an email on file yet — emails come in through online checkout or the optional field on Take Order.</p>
        ) : (
          <>
            <input
              value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject"
              style={{ width: "100%", background: "#1A1512", border: "1px solid #2A2420", borderRadius: 10, padding: "10px 12px", color: c.cream, fontSize: 13, marginBottom: 8 }}
            />
            <textarea
              value={body} onChange={(e) => setBody(e.target.value)} placeholder="What do you want to tell your customers?" rows={5}
              style={{ width: "100%", background: "#1A1512", border: "1px solid #2A2420", borderRadius: 10, padding: "10px 12px", color: c.cream, fontSize: 13, marginBottom: 10, resize: "vertical", fontFamily: "inherit" }}
            />
            <p style={{ fontSize: 10.5, color: c.stone, marginBottom: 10 }}>Every email includes an unsubscribe link automatically.</p>
            {error && <p style={{ color: c.red, fontSize: 11, marginBottom: 8 }}>{error}</p>}
            {result && <p style={{ color: c.green, fontSize: 11, marginBottom: 8 }}>✓ {result}</p>}
            <button
              onClick={send} disabled={sending || !subject.trim() || !body.trim()}
              style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "12px", borderRadius: 10, fontWeight: 800, fontSize: 13, cursor: "pointer", opacity: (sending || !subject.trim() || !body.trim()) ? 0.6 : 1 }}
            >
              {sending ? "Sending…" : `Send to ${audienceCount} Customer${audienceCount === 1 ? "" : "s"}`}
            </button>
          </>
        )}
      </div>

      <span className="mono" style={{ fontSize: 11, letterSpacing: 2, color: c.gold }}>HISTORY</span>
      <h2 className="display" style={{ fontSize: 18, fontWeight: 700, margin: "4px 0 12px" }}>Past Campaigns</h2>
      {campaigns.length === 0 && <p style={{ fontSize: 12, color: c.stone }}>No campaigns sent yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {campaigns.map((camp) => (
          <div key={camp.id} style={{ background: c.card, border: `1px solid #2A2420`, borderRadius: 12, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4, gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{camp.subject}</span>
              <span style={{ fontSize: 10, fontWeight: 800, color: camp.status === "sent" ? c.green : camp.status === "failed" ? c.red : c.gold, textTransform: "uppercase", flexShrink: 0 }}>{camp.status}</span>
            </div>
            <p style={{ fontSize: 12, color: c.stone, marginBottom: 6, whiteSpace: "pre-wrap" }}>{camp.body.length > 120 ? `${camp.body.slice(0, 120)}…` : camp.body}</p>
            <span className="mono" style={{ fontSize: 10, color: c.stone }}>{camp.recipient_count} recipient{camp.recipient_count === 1 ? "" : "s"} · {new Date(camp.sent_at || camp.created_at).toLocaleDateString()}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function TakeOrderPanel({ c, truck, menu, categories, session, onCreated }) {
  const [cart, setCart] = useState({}); // { menu_item_id: qty }
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const available = menu.filter((m) => !m.sold_out);
  const shown = activeCategory === "all" ? available : available.filter((m) => m.category_id === activeCategory);
  const cartEntries = Object.entries(cart).filter(([, qty]) => qty > 0);
  const cartCount = cartEntries.reduce((sum, [, qty]) => sum + qty, 0);
  const total = cartEntries.reduce((sum, [id, qty]) => {
    const item = menu.find((m) => m.id === id);
    return sum + (item ? item.price * qty : 0);
  }, 0);

  const bump = (id, delta) => setCart((prev) => ({ ...prev, [id]: Math.max(0, (prev[id] || 0) + delta) }));

  const submit = async () => {
    if (cartEntries.length === 0) { setError("Add at least one item."); return; }
    setSubmitting(true);
    setError("");
    try {
      const res = await authedFn("owner-create-order", {
        slug: truck.slug,
        customer_name: customerName.trim(),
        customer_email: customerEmail.trim() || undefined,
        items: cartEntries.map(([menu_item_id, qty]) => ({ menu_item_id, qty })),
      }, session.access_token);
      if (res.error) { setError(res.error); return; }
      onCreated(res.order);
      setCart({});
      setCustomerName("");
      setCustomerEmail("");
    } catch (e) {
      setError(`Could not place order — ${e.message}.`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ background: c.card, border: `1px solid #2A2420`, borderRadius: 14, padding: 16, marginBottom: 18 }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Take an Order</h3>
      {available.length === 0 && <p style={{ fontSize: 12, color: c.stone }}>Add menu items first to take an order.</p>}

      {available.length > 0 && categories.length > 0 && (
        <div className="scrollx" style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, marginBottom: 12 }}>
          {[{ id: "all", name: "All" }, ...categories].map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              style={{
                flexShrink: 0, background: activeCategory === cat.id ? c.gold : "none",
                color: activeCategory === cat.id ? "#1A1210" : c.stone,
                border: `1px solid ${activeCategory === cat.id ? c.gold : "#3A322C"}`,
                borderRadius: 999, padding: "7px 13px", fontSize: 11, fontWeight: 700, letterSpacing: 0.3, cursor: "pointer", whiteSpace: "nowrap", textTransform: "uppercase",
              }}
            >
              {cat.name}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: cartCount > 0 ? 14 : 4 }}>
        {shown.map((item) => (
          <div key={item.id} style={{ background: "#1A1512", border: `1px solid ${cart[item.id] > 0 ? c.gold : "#2A2420"}`, borderRadius: 14, overflow: "hidden" }}>
            <div style={{ height: 84, background: item.photo_url ? `url(${item.photo_url}) center/cover` : "#0E0B09", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {!item.photo_url && <ImageIcon size={18} color={c.stone} />}
            </div>
            <div style={{ padding: "8px 10px 10px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
              <div className="mono" style={{ fontSize: 11, color: c.gold, marginBottom: 8 }}>${Number(item.price).toFixed(2)}</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <button onClick={() => bump(item.id, -1)} style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "1px solid #3A322C", borderRadius: "50%", width: 24, height: 24, color: c.cream, cursor: "pointer" }}><Minus size={12} /></button>
                <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: cart[item.id] > 0 ? c.gold : c.cream }}>{cart[item.id] || 0}</span>
                <button onClick={() => bump(item.id, 1)} style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: `1px solid ${c.gold}`, borderRadius: "50%", width: 24, height: 24, color: c.gold, cursor: "pointer" }}><Plus size={12} /></button>
              </div>
            </div>
          </div>
        ))}
        {shown.length === 0 && available.length > 0 && (
          <p style={{ gridColumn: "1 / -1", fontSize: 12, color: c.stone, textAlign: "center", padding: 16 }}>No items in this category.</p>
        )}
      </div>

      {cartCount > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: 14, marginBottom: 12 }}>
          <span>{cartCount} item{cartCount === 1 ? "" : "s"}</span><span style={{ color: c.gold }}>${total.toFixed(2)}</span>
        </div>
      )}

      <input
        value={customerName} onChange={(e) => setCustomerName(e.target.value)}
        placeholder="Customer name"
        style={{ width: "100%", background: "#1A1512", border: "1px solid #2A2420", borderRadius: 10, padding: "10px 12px", color: c.cream, fontSize: 13, marginBottom: 8 }}
      />
      <input
        value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)}
        placeholder="Email (optional)" type="email"
        style={{ width: "100%", background: "#1A1512", border: "1px solid #2A2420", borderRadius: 10, padding: "10px 12px", color: c.cream, fontSize: 13, marginBottom: 10 }}
      />
      {error && <p style={{ color: c.red, fontSize: 11, marginBottom: 8 }}>{error}</p>}
      <button
        onClick={submit} disabled={submitting || cartEntries.length === 0}
        style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "12px", borderRadius: 10, fontWeight: 800, fontSize: 13, cursor: cartEntries.length === 0 ? "default" : "pointer", opacity: cartEntries.length === 0 ? 0.5 : 1 }}
      >
        {submitting ? "Placing…" : "Place Order"}
      </button>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// Glass-panel surfaces (Home tab) need a translucent version of whatever
// hex color the truck's theme provides, not a fixed one -- this is the
// hex -> rgba(...) conversion that makes that possible.
function hexAlpha(hex, a) {
  const h = (hex || "#000000").replace("#", "");
  const full = h.length === 3 ? h.split("").map((ch) => ch + ch).join("") : h;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/* ============================= OWNER DASHBOARD SHELL =============================
   One shared dashboard for both admin-owned trucks and regular owners --
   they used to be two near-identical ~500-line components that only really
   differed in three places (nav identity text, the This Truck/All Trucks
   switcher, and the marketplace-listing toggle), all handled here with an
   `isAdmin` check instead of forking the whole component.

   Nav is Home | Orders | Menu | Website | More: operational things an owner
   checks daily (is it open, where's it parked, what are today's orders) up
   front, configuration/settings things collapsed under Website and More. */
function Dashboard({ c, data, session, onLogout, goSite, role }) {
  const isAdmin = role === "admin";
  const { truck, theme: themeRow, location: initialLocation, menu: initialMenu, faqs: initialFaqs, categories: initialCategories, loadOrders, reload } = data;

  const [view, setView] = useState("dashboard"); // 'dashboard' | 'trucks' (admin-only truck switcher)
  const [tab, setTab] = useState("home"); // 'home' | 'orders' | 'menu' | 'website' | 'more'
  const [categories, setCategories] = useState(initialCategories || []);
  const [listed, setListed] = useState(truck.is_listed || false);
  const [listedSaved, setListedSaved] = useState(false);
  const [spot, setSpot] = useState(initialLocation?.spot || "");
  const [until, setUntil] = useState(initialLocation?.open_until || "");
  const [status, setStatus] = useState(initialLocation?.status || "OPEN");
  const [lat, setLat] = useState(initialLocation?.lat ?? null);
  const [lng, setLng] = useState(initialLocation?.lng ?? null);
  const [locationEditing, setLocationEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState(null);
  const [menu, setMenu] = useState(initialMenu);
  const [faqs, setFaqs] = useState(initialFaqs);
  const [orders, setOrders] = useState([]);
  const [showAllOrders, setShowAllOrders] = useState(false);
  const [campaigns, setCampaigns] = useState([]);
  const [unsubscribedEmails, setUnsubscribedEmails] = useState([]);
  const [newQ, setNewQ] = useState("");
  const [newA, setNewA] = useState("");
  const [newItem, setNewItem] = useState({ name: "", price: "", description: "", photoFile: null, photoPreview: null });
  const [newItemError, setNewItemError] = useState("");
  const [addingItem, setAddingItem] = useState(false);
  const [uploading, setUploading] = useState("");

  useEffect(() => {
    loadOrders(truck.id, session.access_token).then(setOrders);
  }, [truck.id, session.access_token, loadOrders]);

  const loadCampaigns = useCallback(() => {
    authedRest(`email_campaigns?truck_id=eq.${truck.id}&select=*&order=created_at.desc`, { token: session.access_token }).then((r) => (r.ok ? r.json() : [])).then(setCampaigns);
  }, [truck.id, session.access_token]);

  useEffect(() => {
    loadCampaigns();
    authedRest(`email_unsubscribes?truck_id=eq.${truck.id}&select=email`, { token: session.access_token }).then((r) => (r.ok ? r.json() : [])).then((rows) => setUnsubscribedEmails(rows.map((row) => row.email)));
  }, [truck.id, session.access_token, loadCampaigns]);

  const authedPatch = (path, body) =>
    authedRest(path, { method: "PATCH", token: session.access_token, body: JSON.stringify(body), prefer: "return=representation" });
  const authedPost = (path, body) =>
    authedRest(path, { method: "POST", token: session.access_token, body: JSON.stringify(body), prefer: "return=representation" });
  const authedDelete = (path) => authedRest(path, { method: "DELETE", token: session.access_token, prefer: "return=minimal" });

  const statusStyle = { new: c.red, preparing: c.gold, ready: c.green, completed: c.stone };
  const statusLabel = { new: "NEW", preparing: "PREPARING", ready: "READY", completed: "COMPLETED" };
  const nextStatus = { new: "preparing", preparing: "ready", ready: "completed" };

  const advanceOrder = async (order) => {
    const next = nextStatus[order.status];
    if (!next) return;
    setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, status: next } : o)));
    await authedPatch(`orders?id=eq.${order.id}`, { status: next });
  };

  const saveLocation = async () => {
    setSaveError("");
    try {
      const res = await authedPatch(`truck_location?truck_id=eq.${truck.id}`, { spot, open_until: until, status, lat, lng });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSaveError(err.message || "Update failed — check you're logged in as admin.");
        return;
      }
      // A PATCH that matches no row still returns 200 with an empty body,
      // so an absent truck_location row would otherwise look like a save.
      const rows = await res.json().catch(() => null);
      if (Array.isArray(rows) && rows.length === 0) {
        setSaveError("Nothing was saved — this truck has no location record yet. Contact support.");
        return;
      }
      setSaved(true);
      setLocationEditing(false);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setSaveError(`Update failed — ${e.message}. Check your connection and try again.`);
    }
  };

  const toggleSoldOut = async (item) => {
    const next = !item.sold_out;
    setMenu((prev) => prev.map((m) => (m.id === item.id ? { ...m, sold_out: next } : m)));
    await authedPatch(`menu_items?id=eq.${item.id}`, { sold_out: next });
  };

  const setPromoTag = async (item, tag) => {
    setMenu((prev) => prev.map((m) => (m.id === item.id ? { ...m, promo_tag: tag } : m)));
    await authedPatch(`menu_items?id=eq.${item.id}`, { promo_tag: tag });
  };
  const setPromoNote = async (item, note) => {
    setMenu((prev) => prev.map((m) => (m.id === item.id ? { ...m, promo_note: note } : m)));
    await authedPatch(`menu_items?id=eq.${item.id}`, { promo_note: note });
  };

  const setItemCategory = async (item, categoryId) => {
    setMenu((prev) => prev.map((m) => (m.id === item.id ? { ...m, category_id: categoryId } : m)));
    await authedPatch(`menu_items?id=eq.${item.id}`, { category_id: categoryId });
  };
  const saveCategory = async (id, draft) => {
    setCategories((prev) => prev.map((cat) => (cat.id === id ? { ...cat, ...draft } : cat)));
    await authedPatch(`menu_categories?id=eq.${id}`, { name: draft.name, caption: draft.caption || null });
  };
  const addCategory = async (name) => {
    const key = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36)}`;
    const res = await authedPost(`menu_categories`, { truck_id: truck.id, key, name, sort_order: categories.length + 1 });
    if (res.ok) { const [created] = await res.json(); setCategories((prev) => [...prev, created]); }
  };
  const deleteCategory = async (id) => {
    setCategories((prev) => prev.filter((cat) => cat.id !== id));
    setMenu((prev) => prev.map((m) => (m.category_id === id ? { ...m, category_id: null } : m)));
    await authedDelete(`menu_categories?id=eq.${id}`);
  };

  const updatePrice = async (item, newPrice) => {
    const price = Number(newPrice);
    if (isNaN(price) || price < 0) return;
    setMenu((prev) => prev.map((m) => (m.id === item.id ? { ...m, price } : m)));
    await authedPatch(`menu_items?id=eq.${item.id}`, { price });
  };

  const addMenuItem = async () => {
    setNewItemError("");
    if (!newItem.name.trim() || !newItem.price) { setNewItemError("Name and price are required."); return; }
    setAddingItem(true);
    // finally-guarded: a thrown fetch used to leave addingItem stuck true,
    // which disabled this button permanently until a page refresh.
    try {
      const res = await authedPost(`menu_items`, {
        truck_id: truck.id,
        name: newItem.name.trim(),
        description: newItem.description.trim(),
        price: Number(newItem.price),
        sort_order: menu.length + 1,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setNewItemError(err.message || `Could not add item (${res.status}).`);
        return;
      }
      const [created] = await res.json();
      let finalItem = created;
      if (newItem.photoFile) {
        try {
          const url = await uploadPhoto(newItem.photoFile, `trucks/${truck.id}/menu/${created.id}-${Date.now()}.${newItem.photoFile.name.split(".").pop()}`, session.access_token);
          await authedPatch(`menu_items?id=eq.${created.id}`, { photo_url: url });
          finalItem = { ...created, photo_url: url };
        } catch (e) { setNewItemError(`Item added, but photo upload failed: ${e.message}`); }
      }
      setMenu((prev) => [...prev, finalItem]);
      setNewItem({ name: "", price: "", description: "", photoFile: null, photoPreview: null });
    } catch (e) {
      setNewItemError(`Could not add item — ${e.message}. Check your connection and try again.`);
    } finally {
      setAddingItem(false);
    }
  };

  const deleteMenuItem = async (id) => {
    setMenu((prev) => prev.filter((m) => m.id !== id));
    await authedDelete(`menu_items?id=eq.${id}`);
  };

  const handleMenuPhoto = async (item, file) => {
    setUploading(item.id);
    try {
      const url = await uploadPhoto(file, `trucks/${truck.id}/menu/${item.id}-${Date.now()}.${file.name.split(".").pop()}`, session.access_token);
      const res = await authedPatch(`menu_items?id=eq.${item.id}`, { photo_url: url });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Saved the file but couldn't attach it to the menu item (${res.status})`);
      }
      setMenu((prev) => prev.map((m) => (m.id === item.id ? { ...m, photo_url: url } : m)));
    } catch (e) { alert(e.message); }
    setUploading("");
  };

  const addFaq = async () => {
    if (!newQ.trim() || !newA.trim()) return;
    const res = await authedPost(`faqs`, { truck_id: truck.id, question: newQ.trim(), answer: newA.trim() });
    if (!res.ok) return;
    const created = await res.json();
    setFaqs((prev) => [...prev, ...created]);
    setNewQ(""); setNewA("");
  };
  const removeFaq = async (id) => {
    setFaqs((prev) => prev.filter((f) => f.id !== id));
    await authedDelete(`faqs?id=eq.${id}`);
  };

  const fullSiteUrl = `https://vendorgrub.netlify.app/${truck.slug}`;
  const siteUrlDisplay = `${truck.slug}.vendorgrub.netlify.app`;
  const downloadQR = () => {
    const canvas = document.getElementById("dash-qr");
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `${truck.slug}-qr-code.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };
  const copyLink = () => navigator.clipboard.writeText(fullSiteUrl);

  const activeOrders = orders.filter((o) => o.status !== "completed");
  const todaysOrders = orders.filter((o) => new Date(o.created_at).toDateString() === new Date().toDateString());
  const todaysValue = todaysOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const unsubscribedSet = new Set(unsubscribedEmails);
  const audienceCount = new Set(
    orders.map((o) => o.customer_email?.trim().toLowerCase()).filter((e) => e && !unsubscribedSet.has(e))
  ).size;

  const fontImport = "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Kaushan+Script&family=Pacifico&family=Anton&family=Bebas+Neue&family=Permanent+Marker&family=Alex+Brush&family=JetBrains+Mono:wght@400;600&family=Oswald:wght@500;600;700&display=swap');";

  if (view === "trucks") {
    return (
      <div style={{ background: c.bg, color: c.cream, fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100vh" }}>
        <style>{`${fontImport} .mono { font-family: 'JetBrains Mono', monospace; }`}</style>
        <nav style={{ position: "sticky", top: 0, zIndex: 40, background: "rgba(14,11,9,0.95)", borderBottom: `1px solid #2A2420`, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button onClick={() => setView("dashboard")} style={{ background: "none", border: "none", color: c.stone, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12 }}>← Back to Dashboard</button>
          <span className="mono" style={{ fontSize: 12, color: c.gold, letterSpacing: 1 }}>ALL TRUCKS</span>
          <button onClick={onLogout} style={{ background: "none", border: "none", color: c.stone, cursor: "pointer" }}><LogOut size={16} /></button>
        </nav>
        <TrucksManager c={c} session={session} currentTruckId={truck.id} />
      </div>
    );
  }

  return (
    <div style={{ background: c.bg, color: c.cream, fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100vh" }}>
      <style>{`
        ${fontImport}
        .mono { font-family: 'JetBrains Mono', monospace; } .display { font-family: 'Oswald', sans-serif; text-transform: uppercase; } .scrollx::-webkit-scrollbar { display: none; }
      `}</style>

      <nav style={{ position: "sticky", top: 0, zIndex: 40, background: "rgba(14,11,9,0.95)", borderBottom: `1px solid #2A2420`, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={goSite} className="display" style={{ background: "none", border: "none", color: c.gold, cursor: "pointer", fontSize: 14, letterSpacing: 0.5 }}>VendorGrub</button>
        <span className="mono" style={{ fontSize: 12, color: c.gold, letterSpacing: 1 }}>{isAdmin ? session.email : `${truck.name} — Owner`}</span>
        <button onClick={onLogout} style={{ background: "none", border: "none", color: c.stone, cursor: "pointer" }}><LogOut size={16} /></button>
      </nav>

      <div style={{ display: "flex", borderBottom: `1px solid #2A2420`, background: "#0A0807" }}>
        {[["home", "Home"], ["orders", "Orders"], ["menu", "Menu"], ["website", "My Website"], ["marketing", "Marketing"], ["more", "More"]].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{ flex: 1, padding: "12px 6px", background: "none", border: "none", borderBottom: tab === key ? `2px solid ${c.gold}` : "2px solid transparent", color: tab === key ? c.gold : c.stone, fontWeight: 700, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>{label}</button>
        ))}
      </div>

      <div style={{ padding: "20px" }}>
        {tab === "home" && (
        <Reveal>
          <div style={{ position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: -40, right: -40, width: 220, height: 220, borderRadius: "50%", background: c.gold, opacity: 0.14, filter: "blur(70px)", pointerEvents: "none" }} />
            <div style={{ position: "absolute", top: 160, left: -60, width: 180, height: 180, borderRadius: "50%", background: c.gold, opacity: 0.08, filter: "blur(70px)", pointerEvents: "none" }} />

            <h1 className="display" style={{ fontSize: 19, fontWeight: 700, marginBottom: 16, position: "relative" }}>{greeting()}, {truck.name} 👋</h1>

            <div style={{ background: hexAlpha(c.card, 0.55), backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", border: `1px solid ${hexAlpha(c.cream, 0.08)}`, borderRadius: 20, padding: 18, marginBottom: 16, boxShadow: `0 8px 30px rgba(0,0,0,0.3), inset 0 1px 0 ${hexAlpha(c.cream, 0.05)}`, position: "relative" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: status === "OPEN" ? c.green : c.red, flexShrink: 0, boxShadow: `0 0 10px ${status === "OPEN" ? c.green : c.red}` }} />
                <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: 0.5 }}>{status === "OPEN" ? "OPEN" : "CLOSED"}</span>
              </div>
              <p style={{ fontSize: 12.5, color: c.stone, marginBottom: 12 }}>
                {lat != null && lng != null ? `📍 Parked at ${spot || "your pinned spot"}${until ? ` · until ${until}` : ""}` : "📍 Not parked yet"}
              </p>

              {!locationEditing ? (
                <button onClick={() => setLocationEditing(true)} style={{ width: "100%", background: hexAlpha(c.gold, 0.08), border: `1px solid ${hexAlpha(c.gold, 0.4)}`, color: c.gold, padding: "11px", borderRadius: 999, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                  {lat != null && lng != null ? "Update Location" : "Set Today's Location"}
                </button>
              ) : (
                <div style={{ marginTop: 6 }}>
                  <label style={{ fontSize: 11.5, color: c.stone, display: "block", marginBottom: 5 }}>Where are you parked?</label>
                  <input value={spot} onChange={(e) => setSpot(e.target.value)} placeholder="e.g. Cole Park, by the pier" style={{ width: "100%", background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginBottom: 12, fontSize: 14 }} />

                  <label style={{ fontSize: 11.5, color: c.stone, display: "block", marginBottom: 5 }}>Serving until</label>
                  <input value={until} onChange={(e) => setUntil(e.target.value)} placeholder="e.g. 8PM" style={{ width: "100%", background: c.bg, border: `1px solid ${c.border}`, borderRadius: 10, padding: "10px 12px", color: c.cream, marginBottom: 14, fontSize: 14 }} />

                  <label style={{ fontSize: 11.5, color: c.stone, display: "block", marginBottom: 5 }}>Drop a pin so customers can find you</label>
                  <LocationPinPicker c={c} lat={lat} lng={lng} onPick={(la, ln) => { setLat(la); setLng(ln); }} onClear={() => { setLat(null); setLng(null); }} />

                  <label style={{ fontSize: 11.5, color: c.stone, display: "block", marginBottom: 5 }}>Are you serving right now?</label>
                  <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                    <button onClick={() => setStatus("OPEN")} style={{ flex: 1, padding: "11px", borderRadius: 999, border: `1px solid ${status === "OPEN" ? c.green : c.border}`, background: status === "OPEN" ? `${c.green}1F` : "transparent", color: status === "OPEN" ? c.green : c.stone, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>OPEN</button>
                    <button onClick={() => setStatus("CLOSED")} style={{ flex: 1, padding: "11px", borderRadius: 999, border: `1px solid ${status === "CLOSED" ? c.red : c.border}`, background: status === "CLOSED" ? `${c.red}1F` : "transparent", color: status === "CLOSED" ? c.red : c.stone, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>CLOSED</button>
                  </div>

                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setLocationEditing(false)} style={{ flex: 1, background: "none", border: `1px solid ${c.border}`, color: c.stone, padding: "12px", borderRadius: 999, fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
                    <button onClick={saveLocation} style={{ flex: 2, background: c.gold, color: "#1A1210", border: "none", padding: "12px", borderRadius: 999, fontWeight: 700, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                      {saved ? <CheckCircle2 size={14} /> : <Send size={14} />} {saved ? "Updated" : "Save Location"}
                    </button>
                  </div>
                  {saveError && <p style={{ color: c.red, fontSize: 11, marginTop: 8 }}>{saveError}</p>}
                </div>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 16, position: "relative" }}>
              {[
                [activeOrders.length, "Active Orders"],
                [todaysOrders.length, "Orders Today"],
                [`$${todaysValue.toFixed(0)}`, "Today's Value"],
              ].map(([value, label]) => (
                <div key={label} style={{ background: hexAlpha(c.card, 0.55), backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", border: `1px solid ${hexAlpha(c.cream, 0.08)}`, borderRadius: 16, padding: "14px 10px", textAlign: "center", boxShadow: `0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 ${hexAlpha(c.cream, 0.05)}` }}>
                  <div className="mono" style={{ fontSize: 21, fontWeight: 800, color: c.gold, textShadow: `0 0 18px ${hexAlpha(c.gold, 0.35)}` }}>{value}</div>
                  <div style={{ fontSize: 10, color: c.stone, marginTop: 3, letterSpacing: 0.3 }}>{label}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16, position: "relative" }}>
              <button onClick={() => setTab("orders")} style={{ background: hexAlpha(c.card, 0.55), backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", border: `1px solid ${hexAlpha(c.cream, 0.08)}`, borderRadius: 16, padding: "16px 14px", color: c.cream, fontWeight: 700, fontSize: 12.5, cursor: "pointer", textAlign: "left", boxShadow: `0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 ${hexAlpha(c.cream, 0.05)}` }}>+ Take Order</button>
              <button onClick={() => setTab("menu")} style={{ background: hexAlpha(c.card, 0.55), backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", border: `1px solid ${hexAlpha(c.cream, 0.08)}`, borderRadius: 16, padding: "16px 14px", color: c.cream, fontWeight: 700, fontSize: 12.5, cursor: "pointer", textAlign: "left", boxShadow: `0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 ${hexAlpha(c.cream, 0.05)}` }}>+ Add Menu Item</button>
            </div>

            <SetupChecklist
              c={c} truck={truck} theme={themeRow} menu={menu} location={{ ...initialLocation, lat, lng, status }}
              onGo={(t) => { setTab(t); if (t === "home") setLocationEditing(true); }}
            />
          </div>
        </Reveal>
        )}

        {tab === "orders" && (
        <Reveal delay={50}>
          <div style={{ marginBottom: 18 }}>
            <TakeOrderPanel c={c} truck={truck} menu={menu} categories={categories} session={session} onCreated={(order) => setOrders((prev) => [order, ...prev])} />
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
              <div>
                <span className="mono" style={{ fontSize: 11, letterSpacing: 2, color: c.gold }}>QUEUE</span>
                <h2 className="display" style={{ fontSize: 18, fontWeight: 700, margin: "4px 0 0" }}>Live Orders ({activeOrders.length} active)</h2>
              </div>
              {orders.length > activeOrders.length && (
                <button onClick={() => setShowAllOrders((s) => !s)} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: c.gold, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                  {showAllOrders ? "Active only" : "View all"} <ArrowRight size={12} />
                </button>
              )}
            </div>
            {orders.length === 0 && <p style={{ fontSize: 12, color: c.stone }}>No orders yet.</p>}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {(showAllOrders ? orders : activeOrders).map((o) => (
                <div key={o.id} style={{ background: c.card, border: `1px solid #2A2420`, borderLeft: `3px solid ${statusStyle[o.status]}`, borderRadius: 12, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="mono" style={{ fontSize: 13, fontWeight: 800 }}>#{String(o.order_number).padStart(3, "0")}</span>
                      <span style={{ background: hexAlpha(statusStyle[o.status], 0.18), color: statusStyle[o.status], borderRadius: 999, padding: "3px 9px", fontSize: 10, fontWeight: 800, letterSpacing: 0.5 }}>{statusLabel[o.status]}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      {o.fulfillment === "pickup" ? <Store size={11} color={c.stone} /> : <Truck size={11} color={c.stone} />}
                      <span className="mono" style={{ fontSize: 10, color: c.stone }}>{new Date(o.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{o.customer_name}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 10 }}>
                    {(o.items || []).map((it, idx) => (
                      <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: c.stone }}>
                        <span>{it.qty} {it.name}</span>
                        <span className="mono">${(Number(it.price) * it.qty).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: 13, marginBottom: 12, paddingTop: 8, borderTop: "1px dashed #3A322C" }}>
                    <span>Total</span><span style={{ color: c.gold }}>${Number(o.total).toFixed(2)}</span>
                  </div>
                  <button onClick={() => advanceOrder(o)} disabled={o.status === "completed"} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, background: "none", border: `1px solid ${statusStyle[o.status]}`, color: statusStyle[o.status], padding: "8px 12px", borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: o.status === "completed" ? "default" : "pointer" }}>
                    {o.status === "completed" ? <CheckCircle2 size={12} /> : <Circle size={12} />} {statusLabel[o.status]} {o.status !== "completed" && "— tap to advance"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
        )}

        {tab === "menu" && (
        <Reveal delay={80}>
          <div style={{ marginBottom: 18 }}>
            <p style={{ fontSize: 12.5, color: c.stone, marginBottom: 14, lineHeight: 1.5 }}>Everything you add here shows up on your site straight away. A photo and a short description sell an item far better than a name on its own.</p>

            <Collapsible c={c} icon={<LayoutDashboard size={17} />} title="Menu categories" summary="Group items so customers (and you, taking a counter order) can browse by category">
              <MenuCategoriesPanel c={c} categories={categories} onSave={saveCategory} onAdd={addCategory} onDelete={deleteCategory} />
            </Collapsible>

            <div style={{ background: c.card, border: `1px dashed #3A322C`, borderRadius: 12, padding: 14, marginBottom: 16 }}>
              <label style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, height: 100, border: `1px dashed #3A322C`, borderRadius: 10, marginBottom: 10, cursor: "pointer", overflow: "hidden", background: newItem.photoPreview ? `url(${newItem.photoPreview}) center/cover` : "transparent" }}>
                {!newItem.photoPreview && <><ImageIcon size={20} color={c.stone} /><span style={{ fontSize: 11, color: c.stone }}>Add a photo</span></>}
                <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => e.target.files[0] && setNewItem((s) => ({ ...s, photoFile: e.target.files[0], photoPreview: URL.createObjectURL(e.target.files[0]) }))} />
              </label>
              <input value={newItem.name} onChange={(e) => setNewItem((s) => ({ ...s, name: e.target.value }))} placeholder="Item name…" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
              <input value={newItem.description} onChange={(e) => setNewItem((s) => ({ ...s, description: e.target.value }))} placeholder="Description…" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
              <input value={newItem.price} onChange={(e) => setNewItem((s) => ({ ...s, price: e.target.value }))} type="number" step="0.01" placeholder="Price" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
              {newItemError && <p style={{ color: c.red, fontSize: 11, marginBottom: 8 }}>{newItemError}</p>}
              <button onClick={addMenuItem} disabled={addingItem} style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "10px", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: "pointer", opacity: addingItem ? 0.6 : 1 }}>
                {addingItem ? "Adding…" : "+ Add to Menu"}
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {menu.length === 0 && <p style={{ fontSize: 12, color: c.stone, textAlign: "center", padding: 20 }}>No items yet — add your first one above.</p>}
              {menu.map((item) => (
                <div key={item.id} style={{ background: c.card, border: `1px solid #2A2420`, borderRadius: 12, padding: 12, display: "flex", gap: 12 }}>
                  <label style={{ width: 56, height: 56, borderRadius: 8, flexShrink: 0, cursor: "pointer", overflow: "hidden", background: item.photo_url ? `url(${item.photo_url}) center/cover` : "#0E0B09", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {!item.photo_url && <ImageIcon size={16} color={c.stone} />}
                    {uploading === item.id && <span className="mono" style={{ fontSize: 8, color: c.gold }}>...</span>}
                    <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => e.target.files[0] && handleMenuPhoto(item, e.target.files[0])} />
                  </label>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className="mono" style={{ fontSize: 9, color: c.stone, letterSpacing: 1 }}>ITEM</span>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{item.name}</span>
                      <button onClick={() => deleteMenuItem(item.id)} style={{ background: "none", border: "none", color: c.stone, cursor: "pointer", flexShrink: 0 }}><Trash2 size={13} /></button>
                    </div>
                    {item.description && <p style={{ fontSize: 11, color: c.stone, margin: "2px 0 6px", lineHeight: 1.3 }}>{item.description}</p>}
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="mono" style={{ fontSize: 11, color: c.stone }}>$</span>
                      <input type="number" step="0.01" defaultValue={item.price} onBlur={(e) => updatePrice(item, e.target.value)} style={{ width: 60, background: c.bg, border: `1px solid #2A2420`, borderRadius: 6, padding: "4px 6px", color: c.cream, fontSize: 11 }} />
                      <button onClick={() => toggleSoldOut(item)} style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: item.sold_out ? c.red : c.green, cursor: "pointer", fontSize: 10, fontWeight: 700 }}>
                        {item.sold_out ? <><EyeOff size={11} /> SOLD OUT</> : <><Eye size={11} /> AVAILABLE</>}
                      </button>
                    </div>
                    <PromoTagPicker c={c} item={item} onSetTag={setPromoTag} onSetNote={setPromoNote} />
                    {categories.length > 0 && (
                      <CategoryPicker c={c} item={item} categories={categories} onSetCategory={setItemCategory} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
        )}

        {tab === "website" && (
        <Reveal delay={80}>
          <div style={{ background: c.card, border: `1px solid #2A2420`, borderRadius: 14, padding: 16, marginBottom: 18, textAlign: "center" }}>
            <p style={{ fontSize: 11, color: c.green, fontWeight: 700, marginBottom: 6 }}>● YOUR SITE IS LIVE</p>
            <p className="mono" style={{ fontSize: 12, color: c.gold, marginBottom: 14 }}>{siteUrlDisplay}</p>
            <div style={{ background: "#fff", borderRadius: 12, padding: 12, display: "inline-block", marginBottom: 12 }}>
              <QRCodeCanvas id="dash-qr" value={fullSiteUrl} size={110} fgColor="#0A0A0A" bgColor="#ffffff" />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={goSite} style={{ flex: 1, background: c.gold, color: "#1A1210", border: "none", padding: "10px", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>View Site</button>
              <button onClick={copyLink} style={{ flex: 1, background: "none", border: `1px solid #3A322C`, color: c.cream, padding: "10px", borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Copy Link</button>
              <button onClick={downloadQR} style={{ flex: 1, background: "none", border: `1px solid #3A322C`, color: c.cream, padding: "10px", borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Download QR</button>
            </div>
          </div>

          <p style={{ fontSize: 11.5, color: c.stone, marginBottom: 12 }}>Everything below changes what customers see on your site.</p>

          <Collapsible c={c} icon={<LayoutDashboard size={17} />} title="Change your style" summary="Colors, layout and lettering in one tap">
            <TemplateSwitcher c={c} truck={truck} theme={themeRow} session={session} reload={reload} />
          </Collapsible>
          <Collapsible c={c} icon={<Palette size={17} />} title="Fine-tune colors" summary="Optional — set your own background, accent and text colors">
            <ThemeColorsPanel c={c} truck={truck} theme={themeRow} session={session} reload={reload} />
          </Collapsible>

          <Collapsible
            c={c} icon={<Truck size={17} />} title="About your truck"
            summary={truck.about_text ? "Name, photo, lettering and your story" : "Name, photo, lettering — add your story"}
            open={profileOpen} onToggle={setProfileOpen}
          >
            <TruckProfilePanel bare c={c} truck={truck} theme={themeRow} session={session} reload={reload} onDraftChange={setProfileDraft} />
          </Collapsible>

          <Collapsible c={c} icon={<MessageCircle size={17} />} title="Customer questions" summary="Whatever you add here, your site's chatbot knows instantly">
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
              {faqs.map((f) => (
                <div key={f.id} style={{ background: c.bg, border: `1px solid #2A2420`, borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{f.question}</span>
                      <p style={{ fontSize: 12, color: c.stone, marginTop: 3 }}>{f.answer}</p>
                    </div>
                    <button onClick={() => removeFaq(f.id)} style={{ background: "none", border: "none", color: c.stone, cursor: "pointer", flexShrink: 0 }}><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ background: c.bg, border: `1px dashed #3A322C`, borderRadius: 10, padding: 12 }}>
              <input value={newQ} onChange={(e) => setNewQ(e.target.value)} placeholder="New question customers ask…" style={{ width: "100%", background: c.card, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
              <textarea value={newA} onChange={(e) => setNewA(e.target.value)} placeholder="Your answer…" rows={2} style={{ width: "100%", background: c.card, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8, resize: "vertical" }} />
              <button onClick={addFaq} style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "9px", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Add to Chatbot</button>
            </div>
          </Collapsible>

          <div style={{ marginTop: 22, paddingTop: 18, borderTop: `1px solid #2A2420` }}>
            <LivePreviewFrame
              truck={truck} theme={themeRow} draft={profileDraft}
              location={{ ...initialLocation, spot, open_until: until, status, lat, lng }}
              menu={menu} faqs={faqs} categories={categories}
            />
          </div>
        </Reveal>
        )}

        {tab === "marketing" && (
        <Reveal delay={80}>
          <p style={{ fontSize: 12.5, color: c.stone, marginBottom: 14, lineHeight: 1.5 }}>Email your past customers directly — anyone who's given you their email at checkout or a counter order, minus anyone who's unsubscribed.</p>
          <MarketingPanel c={c} truck={truck} audienceCount={audienceCount} campaigns={campaigns} session={session} onSent={loadCampaigns} />
        </Reveal>
        )}

        {tab === "more" && (
        <Reveal delay={80}>
          <Collapsible c={c} icon={<Lock size={17} />} title="Account" summary="Your login email and password">
            <AccountPanel bare c={c} session={session} />
          </Collapsible>
          <Collapsible c={c} icon={<Store size={17} />} title="Kitchen screen PIN" summary="For staff taking orders on a second screen">
            <KitchenPinPanel bare c={c} truck={truck} session={session} />
          </Collapsible>
          <Collapsible c={c} icon={<Truck size={17} />} title="Delivery settings" summary="Optional — set a delivery fee and how far you'll go">
            <DeliverySettingsPanel bare c={c} truck={truck} session={session} />
          </Collapsible>
          <Collapsible c={c} icon={<span style={{ fontSize: 15 }}>🎁</span>} title="Rewards" summary="Set up a loyalty points program for repeat customers">
            <LoyaltyPanel c={c} truck={truck} session={session} />
          </Collapsible>

          {isAdmin && (
            <>
              <Collapsible c={c} icon={<Store size={17} />} title="Marketplace listing" summary="Shows up on /trucks for real customers to find and order from">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: c.bg, border: `1px solid #2A2420`, borderRadius: 10, padding: "10px 12px", marginBottom: 14 }}>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>Public Marketplace Listing</div>
                    <div style={{ fontSize: 10, color: c.stone, marginTop: 2 }}>Shows up on /trucks for real customers to find and order from.</div>
                  </div>
                  <button onClick={() => setListed((l) => !l)} style={{ background: listed ? c.green : "#3A322C", border: "none", borderRadius: 999, width: 44, height: 24, position: "relative", cursor: "pointer", flexShrink: 0, marginLeft: 10 }}>
                    <span style={{ position: "absolute", top: 3, left: listed ? 23 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
                  </button>
                </div>
                <button
                  onClick={async () => { const res = await authedPatch(`trucks?id=eq.${truck.id}`, { is_listed: listed }); if (res.ok) { setListedSaved(true); reload(); setTimeout(() => setListedSaved(false), 1800); } }}
                  style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "12px", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}
                >
                  {listedSaved ? "✓ Saved" : "Save Listing Setting"}
                </button>
              </Collapsible>
              <button onClick={() => setView("trucks")} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: c.card, border: `1px solid #2A2420`, borderRadius: 12, padding: "14px 16px", color: c.cream, fontWeight: 700, fontSize: 13, cursor: "pointer", marginBottom: 12 }}>
                All Trucks <ArrowRight size={15} />
              </button>
            </>
          )}

          <button onClick={onLogout} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "none", border: `1px solid #2A2420`, borderRadius: 12, padding: "14px 16px", color: c.stone, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            <LogOut size={14} /> Log Out
          </button>
        </Reveal>
        )}
      </div>
    </div>
  );
}

function TrucksManager({ c, session, currentTruckId }) {
  const [trucks, setTrucks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ slug: "", name: "", phone: "", tagline: "" });
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null); // slug pending confirmation
  const [busy, setBusy] = useState("");

  const [templates, setTemplates] = useState(null);
  const [ownerForm, setOwnerForm] = useState({ slug: "", name: "", phone: "", tagline: "", template_key: "", owner_email: "", owner_password: "" });
  const [creatingOwner, setCreatingOwner] = useState(false);
  const [ownerError, setOwnerError] = useState("");
  const [ownerResult, setOwnerResult] = useState(null); // { slug, owner_email, owner_password } — shown once, right after creation
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    rest(`site_templates?select=*&order=sort_order`).then((r) => r.json()).then(setTemplates);
  }, []);

  // Random, readable-enough password so the admin isn't stuck inventing one
  // for someone else's account — still meets the app's own 8-char minimum
  // several times over.
  const generatePassword = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
    const arr = new Uint32Array(14);
    crypto.getRandomValues(arr);
    let pw = "";
    for (let i = 0; i < arr.length; i++) pw += chars[arr[i] % chars.length];
    setOwnerForm((s) => ({ ...s, owner_password: pw }));
  };

  const loadTrucks = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-trucks-overview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
    });
    const json = await res.json();
    setTrucks(res.ok ? json.trucks : []);
    setLoading(false);
  }, [session.access_token]);

  useEffect(() => { loadTrucks(); }, [loadTrucks]);

  const createTruckWithOwner = async () => {
    setOwnerError("");
    if (!ownerForm.slug.trim() || !ownerForm.name.trim() || !ownerForm.template_key || !ownerForm.owner_email.trim() || ownerForm.owner_password.length < 8) {
      setOwnerError("Slug, name, a design, owner email, and an 8+ character password are all required.");
      return;
    }
    setCreatingOwner(true);
    const res = await authedFn("admin-create-truck-with-owner", {
      slug: ownerForm.slug.trim(), truck_name: ownerForm.name.trim(), phone: ownerForm.phone.trim(),
      tagline: ownerForm.tagline.trim(), template_key: ownerForm.template_key,
      owner_email: ownerForm.owner_email.trim(), owner_password: ownerForm.owner_password,
    }, session.access_token);
    setCreatingOwner(false);
    if (res.error) { setOwnerError(res.error); return; }
    setOwnerResult({ slug: res.slug, owner_email: ownerForm.owner_email.trim(), owner_password: ownerForm.owner_password });
    setOwnerForm({ slug: "", name: "", phone: "", tagline: "", template_key: "", owner_email: "", owner_password: "" });
    loadTrucks();
  };

  const createTruck = async () => {
    setError("");
    if (!form.slug.trim() || !form.name.trim()) { setError("Slug and name are required."); return; }
    setCreating(true);
    const res = await rest(`trucks`, { method: "POST", token: session.access_token, body: JSON.stringify({ slug: form.slug.trim(), name: form.name.trim(), phone: form.phone.trim(), tagline: form.tagline.trim() }) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setError(err.message || "Could not create truck — slug may already be taken.");
      setCreating(false);
      return;
    }
    const [created] = await res.json();
    await Promise.all([
      rest(`truck_theme`, { method: "POST", token: session.access_token, body: JSON.stringify({ truck_id: created.id }) }),
      rest(`truck_location`, { method: "POST", token: session.access_token, body: JSON.stringify({ truck_id: created.id, spot: "Not yet set", open_until: "—", status: "CLOSED" }) }),
    ]);
    setForm({ slug: "", name: "", phone: "", tagline: "" });
    setCreating(false);
    loadTrucks();
  };

  const togglePause = async (t) => {
    setBusy(t.id);
    await rest(`trucks?id=eq.${t.id}`, { method: "PATCH", token: session.access_token, body: JSON.stringify({ is_active: !t.is_active }) });
    setBusy("");
    loadTrucks();
  };

  const deleteTruck = async (slug) => {
    setBusy(slug);
    const res = await authedFn("admin-delete-truck", { slug }, session.access_token);
    setBusy("");
    setConfirmDelete(null);
    if (res.error) { alert(res.error); return; }
    loadTrucks();
  };

  return (
    <div style={{ padding: 20 }}>
      <p style={{ fontSize: 12, color: c.stone, marginBottom: 16, lineHeight: 1.5 }}>
        Every truck below shares this one deployment. Creating one here makes it instantly live at <span className="mono">yourdomain.netlify.app/{"{slug}"}</span> — no code changes, no new Netlify site, no redeploy. You only touch the code again when you want to change the design itself for everyone at once.
      </p>

      <div style={{ background: c.card, border: `1px solid #2A2420`, borderRadius: 12, padding: 14, marginBottom: 20 }}>
        <span style={{ fontWeight: 700, fontSize: 13, display: "block" }}>+ New Truck (unclaimed)</span>
        <span style={{ fontSize: 10.5, color: c.stone, display: "block", marginBottom: 10 }}>No owner login — you manage it yourself from your own admin account. Good for internal test trucks.</span>
        <input value={form.slug} onChange={(e) => setForm((s) => ({ ...s, slug: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "") }))} placeholder="slug (e.g. tacotime)" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
        <input value={form.name} onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} placeholder="Display name" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
        <input value={form.tagline} onChange={(e) => setForm((s) => ({ ...s, tagline: e.target.value }))} placeholder="Tagline" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
        <input value={form.phone} onChange={(e) => setForm((s) => ({ ...s, phone: e.target.value }))} placeholder="Phone" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
        {error && <p style={{ color: c.red, fontSize: 11, marginBottom: 8 }}>{error}</p>}
        <button onClick={createTruck} disabled={creating} style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "10px", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
          {creating ? "Creating…" : "Create Truck"}
        </button>
      </div>

      <div style={{ background: c.card, border: `1px solid ${c.gold}55`, borderRadius: 12, padding: 14, marginBottom: 20 }}>
        <span style={{ fontWeight: 700, fontSize: 13, display: "block" }}>+ New Truck for Someone Else</span>
        <span style={{ fontSize: 10.5, color: c.stone, display: "block", marginBottom: 10 }}>Creates the truck and a real owner login in one step — they can log into /manage themselves right away.</span>

        <input value={ownerForm.slug} onChange={(e) => setOwnerForm((s) => ({ ...s, slug: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "") }))} placeholder="slug (e.g. tacotime)" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
        <input value={ownerForm.name} onChange={(e) => setOwnerForm((s) => ({ ...s, name: e.target.value }))} placeholder="Display name" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
        <input value={ownerForm.tagline} onChange={(e) => setOwnerForm((s) => ({ ...s, tagline: e.target.value }))} placeholder="Tagline" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
        <input value={ownerForm.phone} onChange={(e) => setOwnerForm((s) => ({ ...s, phone: e.target.value }))} placeholder="Phone" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />

        <span style={{ fontSize: 10.5, color: c.stone, display: "block", marginBottom: 6, marginTop: 4 }}>Pick a design</span>
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8, marginBottom: 8 }}>
          {!templates && <span style={{ fontSize: 11, color: c.stone }}>Loading designs…</span>}
          {templates?.map((t) => (
            <button
              key={t.key}
              onClick={() => setOwnerForm((s) => ({ ...s, template_key: t.key }))}
              style={{ flexShrink: 0, width: 84, background: "none", border: `2px solid ${ownerForm.template_key === t.key ? c.gold : "#2A2420"}`, borderRadius: 10, padding: 4, cursor: "pointer" }}
            >
              <TemplateThumb t={t} />
              <span style={{ display: "block", fontSize: 9, color: c.stone, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
            </button>
          ))}
        </div>

        <input value={ownerForm.owner_email} onChange={(e) => setOwnerForm((s) => ({ ...s, owner_email: e.target.value }))} placeholder="Owner's email" type="email" style={{ width: "100%", background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12, marginBottom: 8 }} />
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input value={ownerForm.owner_password} onChange={(e) => setOwnerForm((s) => ({ ...s, owner_password: e.target.value }))} placeholder="Owner's password (8+ chars)" style={{ flex: 1, minWidth: 0, background: c.bg, border: `1px solid #2A2420`, borderRadius: 8, padding: "8px 10px", color: c.cream, fontSize: 12 }} />
          <button onClick={generatePassword} style={{ flexShrink: 0, background: "none", border: `1px solid #2A2420`, color: c.gold, borderRadius: 8, padding: "0 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Generate</button>
        </div>

        {ownerError && <p style={{ color: c.red, fontSize: 11, marginBottom: 8 }}>{ownerError}</p>}
        <button onClick={createTruckWithOwner} disabled={creatingOwner} style={{ width: "100%", background: c.gold, color: "#1A1210", border: "none", padding: "10px", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: "pointer", opacity: creatingOwner ? 0.6 : 1 }}>
          {creatingOwner ? "Creating…" : "Create Truck + Owner Login"}
        </button>

        {ownerResult && (
          <div style={{ background: c.bg, border: `1px solid ${c.green}`, borderRadius: 10, padding: 12, marginTop: 12 }}>
            <p style={{ fontSize: 11, color: c.green, fontWeight: 700, marginBottom: 8 }}>✓ Created — send these to the owner now. The password won't be shown again.</p>
            <div className="mono" style={{ fontSize: 11, color: c.cream, lineHeight: 1.8 }}>
              Site: {ownerResult.slug}.vendorgrub.com<br />
              Login: /login<br />
              Email: {ownerResult.owner_email}<br />
              Password: {ownerResult.owner_password}
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(`Your VendorGrub site is ready!\nSite: ${ownerResult.slug}.vendorgrub.com\nLogin: /login\nEmail: ${ownerResult.owner_email}\nPassword: ${ownerResult.owner_password}`);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              style={{ marginTop: 10, width: "100%", background: "none", border: `1px solid ${c.gold}`, color: c.gold, borderRadius: 8, padding: "8px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
            >
              {copied ? "Copied!" : "Copy Credentials"}
            </button>
          </div>
        )}
      </div>

      {loading ? <p style={{ fontSize: 12, color: c.stone }}>Loading…</p> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {trucks.map((t) => (
            <div key={t.id} style={{ background: c.card, border: `1px solid ${t.id === currentTruckId ? c.gold : "#2A2420"}`, borderRadius: 10, padding: "10px 14px", opacity: t.is_active ? 1 : 0.55 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t.name}</span>
                  <span className="mono" style={{ fontSize: 10, color: c.stone, marginLeft: 8 }}>/{t.slug}</span>
                  {!t.is_active && <span className="mono" style={{ fontSize: 9, color: c.red, marginLeft: 6 }}>PAUSED</span>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="mono" style={{ fontSize: 9, color: t.is_listed ? c.green : c.stone, border: `1px solid ${t.is_listed ? c.green : "#2A2420"}`, borderRadius: 999, padding: "2px 6px" }}>{t.is_listed ? "LISTED" : "HIDDEN"}</span>
                  <a href={`/${t.slug}`} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: c.gold }}>Visit →</a>
                  <a href={`/${t.slug}/manage`} style={{ fontSize: 10, color: c.gold }}>Manage →</a>
                  {t.id === currentTruckId && <span className="mono" style={{ fontSize: 10, color: c.gold }}>VIEWING NOW</span>}
                </div>
              </div>
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #2A2420" }}>
                {t.claimed ? (
                  <>
                    <div style={{ fontSize: 11, color: c.cream }}>Owner: <span className="mono">{t.owner_email}</span></div>
                    <div style={{ fontSize: 10, color: t.owner_last_sign_in_at ? c.green : c.stone, marginTop: 2 }}>
                      {t.owner_last_sign_in_at ? `Last logged in ${new Date(t.owner_last_sign_in_at).toLocaleDateString()}` : "Signed up — hasn't logged in yet"}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 11, color: c.stone }}>No owner account linked yet</div>
                )}
                <div style={{ fontSize: 10, color: t.order_count > 0 ? c.gold : c.stone, marginTop: 4 }}>
                  {t.order_count} order{t.order_count === 1 ? "" : "s"} placed · created {new Date(t.created_at).toLocaleDateString()}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button onClick={() => togglePause(t)} disabled={busy === t.id} style={{ flex: 1, background: "none", border: `1px solid ${t.is_active ? "#2A2420" : c.green}`, color: t.is_active ? c.stone : c.green, padding: "8px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                  {busy === t.id ? "…" : t.is_active ? "Pause Site" : "Reactivate"}
                </button>
                {confirmDelete === t.slug ? (
                  <>
                    <button onClick={() => deleteTruck(t.slug)} disabled={busy === t.slug} style={{ flex: 1, background: c.red, border: "none", color: "#fff", padding: "8px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      {busy === t.slug ? "Deleting…" : "Confirm Delete"}
                    </button>
                    <button onClick={() => setConfirmDelete(null)} style={{ flex: 1, background: "none", border: "1px solid #2A2420", color: c.stone, padding: "8px", borderRadius: 8, fontSize: 11, cursor: "pointer" }}>Cancel</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmDelete(t.slug)} style={{ flex: 1, background: "none", border: "1px solid #2A2420", color: c.red, padding: "8px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                    Delete Truck
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
