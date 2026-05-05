/**
 * Mounts the profile icon dropdown + "My Uploads" modal into any dashboard
 * nav that has a `.glass-nav--dashboard .nav-actions` element.
 *
 * Provides:
 *   - Circular avatar button with dropdown
 *   - "My Uploads" — opens a modal that fetches /api/defects/my
 *   - "Log Out"
 *   - Auth guard (redirects to "/" if not logged in)
 */
import { getToken, getUser, clearAuth } from "/shared/auth.js";
import { openPhotoCropper, isPhotoCropperOpen } from "/shared/profile-photo-cropper.js";

/* ── SVG icons ──────────────────────────────────────────────── */
const AVATAR_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="8" r="4"/>
  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
</svg>`;

const UPLOADS_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true">
  <rect x="3" y="3" width="18" height="18" rx="2"/>
  <circle cx="8.5" cy="8.5" r="1.5"/>
  <polyline points="21 15 16 10 5 21"/>
</svg>`;

const ADMIN_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true">
  <path d="M12 2L2 7l10 5 10-5-10-5z"/>
  <path d="M2 17l10 5 10-5"/>
  <path d="M2 12l10 5 10-5"/>
</svg>`;

const LOGOUT_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true">
  <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
  <polyline points="16 17 21 12 16 7"/>
  <line x1="21" y1="12" x2="9" y2="12"/>
</svg>`;

const CLOSE_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
  aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>`;

const PROFILE_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="8" r="4"/>
  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
</svg>`;

/** Green tick shown after successful profile save (inline in modal) */
const PROFILE_SUCCESS_TICK_SVG = `<svg class="pn-profile-feedback__tick" width="18" height="18" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M20 6L9 17l-5-5"/>
</svg>`;

const EDIT_CAMERA_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>
  <circle cx="12" cy="13" r="4"/>
</svg>`;

/** Longest codes first for prefix match */
const COUNTRY_CODES = [
  { code: "+971", label: "UAE (+971)" },
  { code: "+966", label: "Saudi Arabia (+966)" },
  { code: "+61", label: "Australia (+61)" },
  { code: "+49", label: "Germany (+49)" },
  { code: "+33", label: "France (+33)" },
  { code: "+81", label: "Japan (+81)" },
  { code: "+86", label: "China (+86)" },
  { code: "+55", label: "Brazil (+55)" },
  { code: "+52", label: "Mexico (+52)" },
  { code: "+44", label: "UK (+44)" },
  { code: "+91", label: "India (+91)" },
  { code: "+65", label: "Singapore (+65)" },
  { code: "+1", label: "US / Canada (+1)" },
];
const PROFILE_NAME_MAX_LENGTH = 80;
const PROFILE_MOBILE_MAX_LENGTH = 10;
const PROFILE_SITE_MAX_LENGTH = 80;
const PROFILE_LOCATION_MAX_LENGTH = 120;
const PROFILE_AGE_MIN = 1;
const PROFILE_AGE_MAX = 89;

function escAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {string|undefined|null} full */
function splitMobile(full) {
  const compact = (full || "").trim().replace(/\s/g, "");
  if (!compact) return { code: "+91", national: "" };
  const sorted = [...COUNTRY_CODES].sort((a, b) => b.code.length - a.code.length);
  for (const { code } of sorted) {
    if (compact.startsWith(code))
      return { code, national: compact.slice(code.length) };
  }
  if (compact.startsWith("+")) return { code: "", national: compact };
  return { code: "+91", national: compact };
}

function countryOptionsHtml(selectedCode) {
  const sel = selectedCode || "+91";
  const known = COUNTRY_CODES.some((c) => c.code === sel);
  const lead = known
    ? ""
    : `<option value="${escAttr(sel)}" selected>${escHtml(`Saved (${sel})`)}</option>`;
  return (
    lead +
    COUNTRY_CODES.map(
      (c) =>
        `<option value="${escAttr(c.code)}" ${known && c.code === sel ? "selected" : ""}>${escHtml(c.label)}</option>`,
    ).join("")
  );
}

function keepDigits(value, maxLength) {
  return String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, maxLength);
}

function clampTextLength(value, maxLength) {
  return String(value ?? "").slice(0, maxLength);
}

/* ── All styles injected once (self-contained, works on any page) ── */
const MODAL_CSS = `
/* ── Profile dropdown ── */
.nav-profile{position:relative;display:flex;align-items:center;margin-left:.5rem}
.nav-avatar-btn{width:36px;height:36px;border-radius:50%;border:2px solid #e2e8f0;
  background:#2563eb;cursor:pointer;display:inline-flex;align-items:center;
  justify-content:center;color:#fff;padding:0;flex-shrink:0;
  font-family:var(--font-sans);font-size:.875rem;font-weight:700;
  letter-spacing:.01em;line-height:1;text-transform:uppercase;
  transition:border-color .15s,box-shadow .15s,background .15s}
.nav-avatar-btn img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}
.nav-avatar-btn--image{background:#fff;color:transparent;overflow:hidden}
.nav-avatar-btn:hover{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.nav-avatar-btn:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.nav-profile-menu{position:absolute;top:calc(100% + 10px);right:0;min-width:200px;
  background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;
  box-shadow:0 8px 24px rgba(15,23,42,.12),0 2px 6px rgba(15,23,42,.06);
  padding:.4rem;z-index:9999;display:none;font-family:var(--font-sans)}
.nav-profile-menu.is-open{display:block}
.nav-profile-menu__header{padding:.5rem .75rem .45rem;border-bottom:1px solid #f1f5f9;margin-bottom:.3rem}
.nav-profile-menu__name{font-size:.82rem;font-weight:700;color:#0f172a;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.nav-profile-menu__email{font-size:.75rem;color:#64748b;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.nav-profile-menu__item{display:flex;align-items:center;gap:.5rem;width:100%;
  padding:.5rem .75rem;border:none;background:transparent;text-align:left;
  font-size:.875rem;color:#334155;font-family:var(--font-sans);
  border-radius:7px;cursor:pointer;transition:background .12s;text-decoration:none}
.nav-profile-menu__item:hover{background:#f1f5f9;color:#1e293b}
.nav-profile-menu__item--danger{color:#dc2626}
.nav-profile-menu__item--danger:hover{background:#fef2f2;color:#b91c1c}
.nav-profile-menu__sep{height:1px;background:#f1f5f9;margin:.3rem 0}
/* ── Uploads modal ── */
.pn-modal-backdrop{position:fixed;inset:0;z-index:20000;background:rgba(15,23,42,.48);
  display:flex;align-items:center;justify-content:center;padding:1rem}
.pn-modal-backdrop.is-hidden{display:none}
.pn-modal{background:#fff;border-radius:14px;width:100%;max-width:800px;
  max-height:85vh;display:flex;flex-direction:column;
  box-shadow:0 20px 60px rgba(15,23,42,.25)}
.pn-modal__header{display:flex;align-items:center;justify-content:space-between;
  padding:1.1rem 1.35rem;border-bottom:1px solid #e2e8f0;flex-shrink:0}
.pn-modal__title{font-size:1rem;font-weight:700;color:#1e293b;
  font-family:var(--font-sans)}
.pn-modal__close{width:32px;height:32px;border:none;background:transparent;
  border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;
  justify-content:center;color:#64748b;transition:background .12s}
.pn-modal__close:hover{background:#f1f5f9;color:#1e293b}
.pn-modal__body{overflow-y:auto;padding:1.1rem 1.35rem;flex:1}
.pn-modal__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:1rem}
.pn-modal__item{border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;
  background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.pn-modal__item img{width:100%;height:140px;object-fit:cover;display:block;cursor:zoom-in}
.pn-modal__item-meta{padding:.6rem .75rem;font-size:.78rem;color:#64748b;line-height:1.5}
.pn-modal__item-meta strong{color:#1e293b}
.pn-modal__empty{text-align:center;padding:2.5rem 1rem;color:#94a3b8;font-size:.9rem}
.pn-modal__loader{text-align:center;padding:2.5rem 1rem;color:#64748b;font-size:.9rem}
.pn-uploads-lightbox-backdrop{position:fixed;inset:0;z-index:21110;background:rgba(15,23,42,.78);
  backdrop-filter:saturate(1.1) blur(10px);-webkit-backdrop-filter:saturate(1.1) blur(10px);
  display:flex;align-items:center;justify-content:center;padding:1.5rem;animation:pnAvatarLbIn .22s ease both}
.pn-uploads-lightbox-card{position:relative;display:inline-block;max-width:min(94vw,1080px);max-height:90vh}
.pn-uploads-lightbox-img{display:block;max-width:min(94vw,1080px);max-height:86vh;width:auto;height:auto;border-radius:16px;
  box-shadow:0 28px 90px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08)}
.pn-uploads-lightbox-close{position:absolute;top:-14px;right:-14px;width:44px;height:44px;border-radius:50%;
  border:1px solid rgba(255,255,255,.22);padding:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  color:#f8fafc;background:rgba(15,23,42,.38);backdrop-filter:blur(16px) saturate(1.35);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.2),0 8px 32px rgba(0,0,0,.35);transition:transform .18s ease,background .18s ease}
.pn-uploads-lightbox-close:hover{background:rgba(15,23,42,.52);transform:scale(1.04)}
.pn-uploads-lightbox-close:active{transform:scale(.96)}
/* ── Profile modal (premium) ── */
#pn-profile-backdrop.pn-modal-backdrop{background:rgba(15,23,42,.44);
  backdrop-filter:saturate(1.15) blur(14px);-webkit-backdrop-filter:saturate(1.15) blur(14px)}
.pn-modal--profile{background:#fff;border-radius:18px;width:100%;max-width:560px;max-height:90vh;
  display:flex;flex-direction:column;box-shadow:0 25px 80px rgba(15,23,42,.18),0 8px 24px rgba(15,23,42,.08);
  border:1px solid rgba(226,232,240,.85);font-family:var(--font-sans)}
#pn-profile-backdrop:not(.is-hidden) .pn-modal--profile{animation:pnProfileIn .34s cubic-bezier(.16,1,.3,1) both}
@keyframes pnProfileIn{from{opacity:0;transform:scale(.96) translateY(10px)}to{opacity:1;transform:scale(1) translateY(0)}}
@media (prefers-reduced-motion:reduce){#pn-profile-backdrop:not(.is-hidden) .pn-modal--profile{animation:none}}
.pn-modal__header--profile{align-items:flex-start;padding:1.25rem 1.5rem 1rem;border-bottom:1px solid #f1f5f9;gap:1rem}
.pn-modal__head-text{min-width:0;flex:1}
.pn-modal__header--profile .pn-modal__title{font-size:1.25rem;font-weight:700;color:#0f172a;letter-spacing:-.02em;
  font-family:var(--font-sans);display:block}
.pn-modal__subtitle{margin:.35rem 0 0;font-size:.8125rem;line-height:1.5;color:#64748b;font-weight:450;max-width:36rem}
.pn-modal__close--profile{width:40px;height:40px;border-radius:12px;flex-shrink:0;margin-top:-.15rem;
  transition:background .18s ease,color .18s ease,transform .15s ease}
.pn-modal__close--profile:hover{background:#f1f5f9;color:#0f172a;transform:scale(1.04)}
.pn-modal__close--profile:active{transform:scale(.96)}
#pn-profile-body.pn-modal__body{padding:1.25rem 1.5rem 1.5rem;overflow-y:auto;flex:1}
.pn-profile-premium{color:#0f172a}
.pn-profile-hero{display:flex;flex-direction:row;align-items:center;gap:1rem 1.15rem;text-align:left;
  margin-bottom:1.1rem;padding-bottom:1.05rem;border-bottom:1px solid #eef2f6}
.pn-profile-avatar-xl-wrap{position:relative;width:76px;height:76px;flex-shrink:0}
button.pn-profile-avatar-xl{width:76px;height:76px;border-radius:50%;border:none;padding:0;font:inherit;
  background:linear-gradient(145deg,#3b82f6,#1d4ed8);
  display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.45rem;font-weight:700;
  box-shadow:0 6px 22px rgba(37,99,235,.26),0 0 0 3px #fff,0 0 0 4px #e8eef5;overflow:hidden;text-transform:uppercase;
  cursor:zoom-in;-webkit-tap-highlight-color:transparent;transition:transform .18s ease,box-shadow .18s ease}
button.pn-profile-avatar-xl:hover{transform:scale(1.03);box-shadow:0 8px 26px rgba(37,99,235,.32),0 0 0 3px #fff,0 0 0 4px #e8eef5}
button.pn-profile-avatar-xl:active{transform:scale(.98)}
button.pn-profile-avatar-xl:focus-visible{outline:2px solid #2563eb;outline-offset:3px}
.pn-profile-avatar-xl img{width:100%;height:100%;object-fit:cover;border-radius:50%;pointer-events:none}
.pn-avatar-lightbox-backdrop{position:fixed;inset:0;z-index:21120;background:rgba(15,23,42,.78);
  backdrop-filter:saturate(1.1) blur(12px);-webkit-backdrop-filter:saturate(1.1) blur(12px);
  display:flex;align-items:center;justify-content:center;padding:1.5rem;animation:pnAvatarLbIn .24s ease both}
@keyframes pnAvatarLbIn{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.pn-avatar-lightbox-backdrop{animation:none}}
.pn-avatar-lightbox-card{position:relative;display:inline-block;max-width:min(92vw,760px);max-height:88vh}
.pn-avatar-lightbox-img{display:block;max-width:min(92vw,760px);max-height:85vh;width:auto;height:auto;border-radius:18px;
  box-shadow:0 28px 90px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08)}
.pn-avatar-lightbox-placeholder{width:min(52vmin,300px);height:min(52vmin,300px);border-radius:50%;
  background:linear-gradient(145deg,#3b82f6,#1d4ed8);color:#fff;display:flex;align-items:center;justify-content:center;
  font-size:clamp(3rem,14vmin,5.5rem);font-weight:700;font-family:var(--font-sans);
  box-shadow:0 28px 90px rgba(37,99,235,.35),0 0 0 4px #fff}
.pn-avatar-lightbox-close{position:absolute;top:-14px;right:-14px;width:44px;height:44px;border-radius:50%;
  border:1px solid rgba(255,255,255,.22);padding:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  color:#f8fafc;background:rgba(15,23,42,.38);-webkit-backdrop-filter:blur(16px) saturate(1.35);backdrop-filter:blur(16px) saturate(1.35);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.2),0 8px 32px rgba(0,0,0,.35),0 0 0 1px rgba(15,23,42,.25);
  transition:transform .2s cubic-bezier(.34,1.56,.64,1),background .2s ease,box-shadow .2s ease,border-color .2s ease,color .2s ease,backdrop-filter .2s ease}
.pn-avatar-lightbox-close svg{display:block;opacity:.92}
.pn-avatar-lightbox-close:hover{color:#fff;background:rgba(15,23,42,.52);border-color:rgba(255,255,255,.3);
  -webkit-backdrop-filter:blur(20px) saturate(1.45);backdrop-filter:blur(20px) saturate(1.45);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.28),0 12px 40px rgba(0,0,0,.4),0 0 0 1px rgba(148,163,184,.15);transform:scale(1.06)}
.pn-avatar-lightbox-close:active{transform:scale(.96)}
.pn-avatar-lightbox-close:focus-visible{outline:2px solid rgba(147,197,253,.9);outline-offset:3px}
@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){
  .pn-avatar-lightbox-close{background:rgba(15,23,42,.88)}
  .pn-avatar-lightbox-close:hover{background:rgba(30,41,59,.92)}
}
.pn-profile-avatar-edit{position:absolute;right:-1px;bottom:-1px;width:30px;height:30px;border-radius:50%;
  border:2px solid #fff;background:#0f172a;color:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  box-shadow:0 3px 12px rgba(15,23,42,.28);transition:transform .18s ease,background .18s ease,box-shadow .18s ease}
.pn-profile-avatar-edit:hover{background:#1e293b;transform:scale(1.06);box-shadow:0 5px 16px rgba(15,23,42,.32)}
.pn-profile-avatar-edit:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.pn-profile-avatar-edit svg{width:14px;height:14px}
.pn-profile-hero-text{margin-top:0;min-width:0;flex:1;width:auto}
.pn-profile-hero-name{font-size:1.05rem;font-weight:700;color:#0f172a;letter-spacing:-.02em;line-height:1.2;word-break:break-word}
.pn-profile-hero-email{margin-top:.2rem;font-size:.8rem;color:#64748b;line-height:1.4;word-break:break-all}
.pn-profile-badge{display:inline-flex;margin-top:.4rem;font-size:.68rem;font-weight:600;text-transform:capitalize;letter-spacing:.02em;
  padding:.22rem .55rem;border-radius:999px;border:1px solid transparent}
.pn-profile-badge--admin{background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe}
.pn-profile-badge--user{background:#f0fdf4;color:#15803d;border-color:#bbf7d0}
.pn-profile-block{margin-top:1.35rem}
.pn-profile-block:first-of-type{margin-top:0}
.pn-profile-block__title{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin:0 0 .75rem}
.pn-profile-block__grid{display:grid;grid-template-columns:1fr 1fr;gap:1.1rem 1.25rem}
.pn-profile-field{display:flex;flex-direction:column;gap:.4rem;min-width:0}
.pn-profile-field--full{grid-column:1/-1}
.pn-profile-field label{font-size:.78rem;font-weight:600;color:#475569;letter-spacing:.01em}
.pn-profile-field input,.pn-profile-field select{width:100%;padding:.65rem .85rem;border:1px solid #e5e7eb;border-radius:12px;
  font-size:.875rem;color:#0f172a;background:#fafafa;transition:border-color .18s ease,box-shadow .18s ease,background .18s ease;font-family:inherit}
.pn-profile-field input::placeholder{color:#cbd5e1}
.pn-profile-field select{background:#fafafa;cursor:pointer;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right .75rem center;padding-right:2.25rem}
.pn-profile-field input:hover,.pn-profile-field select:hover{border-color:#d1d5db;background:#fff}
.pn-profile-field input:focus,.pn-profile-field select:focus{outline:none;border-color:#2563eb;background:#fff;
  box-shadow:0 0 0 4px rgba(37,99,235,.11)}
.pn-profile-field input:read-only{background:#f4f6f8;color:#64748b;cursor:default;border-color:#e8ecf0}
.pn-profile-phone-row{display:grid;grid-template-columns:minmax(7.5rem,9.5rem) 1fr;gap:.65rem;align-items:stretch}
.pn-profile-phone-row select{padding-right:1.75rem;font-size:.8rem}
.pn-profile-field--location input{background-image:linear-gradient(#fafafa,#fafafa);position:relative}
.pn-profile-field--location input::placeholder{color:#cbd5e1}
.pn-profile-actions{display:flex;justify-content:flex-end;gap:.75rem;margin-top:2rem;padding-top:1.5rem;border-top:1px solid #eef2f6}
.pn-profile-btn{font-family:var(--font-sans);font-size:.875rem;font-weight:600;border-radius:12px;padding:.65rem 1.35rem;
  cursor:pointer;transition:background .18s ease,transform .14s ease,box-shadow .18s ease,color .18s ease,border-color .18s ease}
.pn-profile-btn:active{transform:scale(.98)}
.pn-profile-btn--cancel{background:transparent;color:#475569;border:1px solid #e5e7eb}
.pn-profile-btn--cancel:hover{background:#f8fafc;border-color:#d1d5db;color:#0f172a}
.pn-profile-btn--save{background:linear-gradient(180deg,#3b82f6,#2563eb);color:#fff;border:none;
  box-shadow:0 4px 14px rgba(37,99,235,.35),inset 0 1px 0 rgba(255,255,255,.15)}
.pn-profile-btn--save:hover{background:linear-gradient(180deg,#2563eb,#1d4ed8);box-shadow:0 6px 20px rgba(37,99,235,.4)}
.pn-profile-btn--save:disabled{opacity:.52;cursor:not-allowed;box-shadow:none;transform:none}
.pn-profile-feedback-slot{display:flex;justify-content:center;overflow:hidden;
  transition:max-height .28s ease,margin-top .28s ease,opacity .22s ease;
  max-height:0;opacity:0;margin-top:0}
.pn-profile-feedback-slot--open{max-height:4.5rem;opacity:1;margin-top:1rem}
.pn-profile-feedback{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;flex-wrap:wrap;
  width:fit-content;max-width:min(100%,19rem);box-sizing:border-box;
  font-size:.8125rem;font-weight:600;padding:.55rem 1rem;border-radius:12px;
  border:1px solid #bbf7d0;background:#f0fdf4;color:#166534}
.pn-profile-feedback__tick{color:#15803d;flex-shrink:0}
.pn-profile-feedback--error{border-color:#fecaca;background:#fef2f2;color:#b91c1c}
/* Photo cropper overlay */
.pn-crop-backdrop{position:fixed;inset:0;z-index:21050;background:rgba(15,23,42,.5);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;
  padding:1rem;opacity:0;transition:opacity .28s ease}
.pn-crop-backdrop--visible{opacity:1}
.pn-crop-card{background:#fff;border-radius:18px;max-width:400px;width:100%;padding:1.5rem 1.5rem 1.35rem;
  box-shadow:0 24px 64px rgba(15,23,42,.2);border:1px solid #eef2f6;font-family:var(--font-sans)}
.pn-crop-card__head{margin-bottom:1.1rem}
.pn-crop-card__title{font-size:1.1rem;font-weight:700;color:#0f172a;margin:0;letter-spacing:-.02em}
.pn-crop-card__sub{font-size:.8rem;color:#64748b;margin:.35rem 0 0;line-height:1.45}
.pn-crop-viewport{position:relative;width:280px;height:280px;margin:0 auto;border-radius:50%;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.06),0 8px 40px rgba(15,23,42,.12);touch-action:none;cursor:grab;background:#0f172a}
.pn-crop-viewport:active{cursor:grabbing}
.pn-crop-viewport canvas{display:block;width:280px;height:280px;border-radius:50%}
.pn-crop-ring{pointer-events:none;position:absolute;inset:0;border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,.35) inset}
.pn-crop-zoom-wrap{margin-top:1.2rem}
.pn-crop-zoom-rail{display:flex;align-items:center;gap:.25rem;padding:.4rem .45rem;
  background:linear-gradient(165deg,#ffffff 0%,#f8fafc 42%,#eef2f7 100%);
  border:1px solid rgba(226,232,240,.98);border-radius:18px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 6px 28px rgba(15,23,42,.08),0 1px 0 rgba(255,255,255,.5)}
.pn-crop-zoom__cap{flex-shrink:0;width:46px;height:46px;border-radius:14px;border:none;cursor:pointer;color:#64748b;
  background:linear-gradient(180deg,#ffffff,#f1f5f9);
  box-shadow:0 1px 3px rgba(15,23,42,.08),inset 0 1px 0 #fff;
  display:inline-flex;align-items:center;justify-content:center;
  transition:color .2s ease,transform .16s cubic-bezier(.34,1.56,.64,1),box-shadow .2s ease,background .2s ease}
.pn-crop-zoom__cap:hover{color:#2563eb;background:#fff;box-shadow:0 4px 18px rgba(37,99,235,.18),0 0 0 1px rgba(37,99,235,.14)}
.pn-crop-zoom__cap:active{transform:scale(.92)}
.pn-crop-zoom__cap:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.pn-crop-zoom__svg{display:block;pointer-events:none}
.pn-crop-zoom-track{position:relative;flex:1;height:46px;display:flex;align-items:center;min-width:56px;margin:0 .15rem}
.pn-crop-zoom-track__bg{position:absolute;left:2px;right:2px;height:9px;top:50%;transform:translateY(-50%);
  background:linear-gradient(180deg,#e8ecf1,#dfe6ee);border-radius:999px;
  box-shadow:inset 0 1px 2px rgba(15,23,42,.07)}
.pn-crop-zoom-fill{position:absolute;left:2px;top:50%;transform:translateY(-50%);height:9px;border-radius:999px;width:0%;max-width:calc(100% - 4px);
  background:linear-gradient(90deg,#38bdf8,#2563eb,#1e40af);pointer-events:none;z-index:1;
  box-shadow:0 0 20px rgba(37,99,235,.35);transition:width .04s linear}
.pn-crop-zoom__range{position:relative;z-index:2;-webkit-appearance:none;appearance:none;width:100%;height:46px;margin:0;
  background:transparent;cursor:pointer}
.pn-crop-zoom__range::-webkit-slider-runnable-track{height:9px;background:transparent;border-radius:999px}
.pn-crop-zoom__range::-moz-range-track{height:9px;background:transparent;border-radius:999px}
.pn-crop-zoom__range::-webkit-slider-thumb{-webkit-appearance:none;width:24px;height:24px;border-radius:50%;
  background:radial-gradient(circle at 30% 25%,#ffffff,#f1f5f9);border:2.5px solid #2563eb;
  box-shadow:0 2px 10px rgba(37,99,235,.4),0 2px 6px rgba(15,23,42,.12),inset 0 1px 0 #fff;
  margin-top:-7.5px;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease}
.pn-crop-zoom__range::-webkit-slider-thumb:hover{transform:scale(1.08);box-shadow:0 4px 16px rgba(37,99,235,.45),0 2px 6px rgba(15,23,42,.12)}
.pn-crop-zoom__range::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:#fff;border:2.5px solid #2563eb;
  box-shadow:0 2px 10px rgba(37,99,235,.35);cursor:pointer}
.pn-crop-zoom-meta{display:flex;align-items:center;justify-content:center;gap:.55rem;margin-top:.7rem}
.pn-crop-zoom__readout{font-size:1.125rem;font-weight:800;letter-spacing:-.04em;font-variant-numeric:tabular-nums;
  color:#0f172a;line-height:1}
.pn-crop-zoom__hint{font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.14em;color:#94a3b8;padding-top:.12rem}
.pn-crop-actions{display:flex;justify-content:flex-end;gap:.6rem;margin-top:1.35rem;padding-top:1.1rem;border-top:1px solid #f1f5f9}
.pn-crop-btn{font-family:var(--font-sans);font-size:.84rem;font-weight:600;border-radius:10px;padding:.55rem 1.1rem;
  cursor:pointer;border:none;transition:background .15s ease,transform .12s ease}
.pn-crop-btn:active{transform:scale(.97)}
.pn-crop-btn--ghost{background:transparent;color:#475569;border:1px solid #e5e7eb}
.pn-crop-btn--ghost:hover{background:#f8fafc}
.pn-crop-btn--primary{background:#2563eb;color:#fff}
.pn-crop-btn--primary:hover{background:#1d4ed8}
@media(max-width:560px){
  .pn-profile-block__grid{grid-template-columns:1fr}
  .pn-profile-field--full{grid-column:auto}
  .pn-profile-phone-row{grid-template-columns:1fr}
}
@media(max-width:520px){
  .pn-profile-hero{flex-direction:column;align-items:center;text-align:center;gap:.75rem;padding-bottom:1rem}
  .pn-profile-hero-text{text-align:center;width:100%}
}
`;

function injectStyles() {
  if (document.getElementById("pn-modal-styles")) return;
  const tag = document.createElement("style");
  tag.id = "pn-modal-styles";
  tag.textContent = MODAL_CSS;
  document.head.appendChild(tag);
}

/* ── Modal DOM ──────────────────────────────────────────────── */
function buildModal() {
  if (document.getElementById("pn-uploads-backdrop")) return;
  const el = document.createElement("div");
  el.className = "pn-modal-backdrop is-hidden";
  el.id = "pn-uploads-backdrop";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "pn-modal-title");
  el.innerHTML = `
    <div class="pn-modal">
      <div class="pn-modal__header">
        <span class="pn-modal__title" id="pn-modal-title">My Uploads</span>
        <button type="button" class="pn-modal__close" id="pn-modal-close" aria-label="Close">
          ${CLOSE_SVG}
        </button>
      </div>
      <div class="pn-modal__body">
        <div id="pn-modal-content" class="pn-modal__loader">Loading…</div>
      </div>
    </div>`;
  document.body.appendChild(el);

  // Close handlers
  document.getElementById("pn-modal-close").addEventListener("click", closeModal);
  el.addEventListener("click", (e) => { if (e.target === el) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

function openModal() {
  document.getElementById("pn-uploads-backdrop")?.classList.remove("is-hidden");
}

function closeModal() {
  closeUploadsLightbox();
  document.getElementById("pn-uploads-backdrop")?.classList.add("is-hidden");
}

function normalizeUploadImageSrc(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return path.startsWith("/") ? path : `/${path}`;
}

function closeUploadsLightbox() {
  document.getElementById("pn-uploads-lightbox")?.remove();
}

function openUploadsLightbox(imageSrc) {
  closeUploadsLightbox();
  const backdrop = document.createElement("div");
  backdrop.id = "pn-uploads-lightbox";
  backdrop.className = "pn-uploads-lightbox-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "Uploaded image preview");

  const card = document.createElement("div");
  card.className = "pn-uploads-lightbox-card";

  const img = document.createElement("img");
  img.className = "pn-uploads-lightbox-img";
  img.src = imageSrc;
  img.alt = "Uploaded image preview";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "pn-uploads-lightbox-close";
  closeBtn.setAttribute("aria-label", "Close preview");
  closeBtn.innerHTML = CLOSE_SVG;

  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeUploadsLightbox();
      document.removeEventListener("keydown", onKey);
    }
  };
  document.addEventListener("keydown", onKey);

  const closeAndCleanup = () => {
    closeUploadsLightbox();
    document.removeEventListener("keydown", onKey);
  };
  closeBtn.addEventListener("click", closeAndCleanup);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeAndCleanup(); });

  card.appendChild(img);
  card.appendChild(closeBtn);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
}

async function loadAndShowUploads() {
  openModal();
  const content = document.getElementById("pn-modal-content");
  content.className = "pn-modal__loader";
  content.innerHTML = "Loading…";

  try {
    const token = getToken();
    const res = await fetch("/api/defects/my", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      content.className = "pn-modal__empty";
      content.innerHTML = "Failed to load uploads.";
      return;
    }

    const items = await res.json();

    if (!items.length) {
      content.className = "pn-modal__empty";
      content.innerHTML = "You have no uploads yet.";
      return;
    }

    content.className = "";
    content.innerHTML = `<div class="pn-modal__grid">${items.map((d) => `
      <div class="pn-modal__item">
        <img src="${normalizeUploadImageSrc(d.image_path)}" alt="Inspection photo" loading="lazy">
        <div class="pn-modal__item-meta">
          <strong>${d.tower}</strong> · Floor ${d.floor} · Flat ${d.flat}<br>
          ${d.room}<br>
          <span style="font-size:.72rem">${new Date(d.created_at).toLocaleString()}</span>
        </div>
      </div>`).join("")}</div>`;

    content.querySelectorAll(".pn-modal__item img").forEach((imgEl) => {
      imgEl.addEventListener("click", () => openUploadsLightbox(imgEl.currentSrc || imgEl.src));
    });
  } catch {
    content.className = "pn-modal__empty";
    content.innerHTML = "Network error — could not load uploads.";
  }
}

/* ── Profile modal DOM ──────────────────────────────────────── */
function buildProfileModal() {
  if (document.getElementById("pn-profile-backdrop")) return;
  const el = document.createElement("div");
  el.className = "pn-modal-backdrop is-hidden";
  el.id = "pn-profile-backdrop";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "pn-profile-title");
  el.innerHTML = `
    <div class="pn-modal pn-modal--profile">
      <div class="pn-modal__header pn-modal__header--profile">
        <div class="pn-modal__head-text">
          <span class="pn-modal__title" id="pn-profile-title">My Profile</span>
          <p class="pn-modal__subtitle" id="pn-profile-subtitle">Manage your personal information and account settings.</p>
        </div>
        <button type="button" class="pn-modal__close pn-modal__close--profile" id="pn-profile-close" aria-label="Close">
          ${CLOSE_SVG}
        </button>
      </div>
      <div class="pn-modal__body" id="pn-profile-body">
        <div class="pn-modal__loader">Loading…</div>
      </div>
    </div>`;
  document.body.appendChild(el);

  document.getElementById("pn-profile-close").addEventListener("click", closeProfileModal);
  el.addEventListener("click", (e) => { if (e.target === el) closeProfileModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.classList.contains("is-hidden")) {
      if (document.getElementById("pn-avatar-lightbox")) {
        e.preventDefault();
        closeAvatarLightbox();
        return;
      }
      if (isPhotoCropperOpen()) return;
      closeProfileModal();
    }
  });
}

function openProfileModal() {
  document.getElementById("pn-profile-backdrop")?.classList.remove("is-hidden");
}

function closeAvatarLightbox() {
  if (_avatarLightboxOnKey) {
    document.removeEventListener("keydown", _avatarLightboxOnKey);
    _avatarLightboxOnKey = null;
  }
  document.getElementById("pn-avatar-lightbox")?.remove();
}

function closeProfileModal() {
  closeAvatarLightbox();
  document.getElementById("pn-profile-backdrop")?.classList.add("is-hidden");
  clearProfileInlineFeedback();
}

/**
 * Full-screen preview of the current hero profile image (or initial if no photo).
 * @param {string | null} imageSrc
 * @param {string} [fallbackLetter] - first letter when no image
 */
function openProfilePhotoLightbox(imageSrc, fallbackLetter) {
  closeAvatarLightbox();
  const backdrop = document.createElement("div");
  backdrop.id = "pn-avatar-lightbox";
  backdrop.className = "pn-avatar-lightbox-backdrop pn-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "Profile photo preview");

  const card = document.createElement("div");
  card.className = "pn-avatar-lightbox-card";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "pn-avatar-lightbox-close";
  closeBtn.setAttribute("aria-label", "Close preview");
  closeBtn.innerHTML = CLOSE_SVG;

  function onKeyLb(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeAvatarLightbox();
    }
  }
  _avatarLightboxOnKey = onKeyLb;

  closeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeAvatarLightbox();
  });

  if (imageSrc) {
    const img = document.createElement("img");
    img.className = "pn-avatar-lightbox-img";
    img.alt = "Profile photo preview";
    img.src = imageSrc;
    card.appendChild(closeBtn);
    card.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "pn-avatar-lightbox-placeholder";
    ph.textContent = (fallbackLetter || "?").trim().charAt(0).toUpperCase() || "?";
    card.appendChild(closeBtn);
    card.appendChild(ph);
  }

  backdrop.appendChild(card);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeAvatarLightbox();
  });

  document.body.appendChild(backdrop);
  document.addEventListener("keydown", onKeyLb);
}

let _profileFeedbackTimer = null;
/** @type {((e: KeyboardEvent) => void) | null} */
let _avatarLightboxOnKey = null;

function clearProfileInlineFeedback() {
  if (_profileFeedbackTimer) {
    clearTimeout(_profileFeedbackTimer);
    _profileFeedbackTimer = null;
  }
  const slot = document.getElementById("pn-profile-feedback-slot");
  if (!slot) return;
  slot.classList.remove("pn-profile-feedback-slot--open");
  slot.innerHTML = "";
}

/** @param {"success" | "error"} variant */
function showProfileInlineFeedback(msg, variant) {
  const slot = document.getElementById("pn-profile-feedback-slot");
  if (!slot) return;
  if (_profileFeedbackTimer) clearTimeout(_profileFeedbackTimer);

  const inner = document.createElement("div");
  inner.className =
    variant === "error" ? "pn-profile-feedback pn-profile-feedback--error" : "pn-profile-feedback";
  inner.setAttribute("role", "status");

  if (variant === "success") {
    const text = document.createElement("span");
    text.textContent = msg;
    inner.appendChild(text);
    inner.insertAdjacentHTML("beforeend", PROFILE_SUCCESS_TICK_SVG);
  } else {
    inner.textContent = msg;
  }

  slot.innerHTML = "";
  slot.appendChild(inner);
  slot.classList.add("pn-profile-feedback-slot--open");

  const scrollProfileBodyToFeedback = () => {
    const body = document.getElementById("pn-profile-body");
    if (!body) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    body.scrollTo({ top: body.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(scrollProfileBodyToFeedback);
  });

  _profileFeedbackTimer = setTimeout(() => {
    slot.classList.remove("pn-profile-feedback-slot--open");
    slot.innerHTML = "";
    _profileFeedbackTimer = null;
  }, 3000);
}

function avatarHtml(userLike) {
  const source = userLike?.profile_photo;
  if (source) {
    return `<img src="/${source}" alt="Profile photo">`;
  }
  const initial = (userLike?.name || userLike?.email || "?")[0].toUpperCase();
  return initial;
}

function avatarButtonClass(userLike) {
  return userLike?.profile_photo ? "nav-avatar-btn nav-avatar-btn--image" : "nav-avatar-btn";
}

function bindProfileInputGuards() {
  const nameEl = document.getElementById("pf-name");
  const ageEl = document.getElementById("pf-age");
  const mobileEl = document.getElementById("pf-mobile");
  const siteEl = document.getElementById("pf-site");
  const locationEl = document.getElementById("pf-location");

  mobileEl?.addEventListener("input", () => {
    const next = keepDigits(mobileEl.value, PROFILE_MOBILE_MAX_LENGTH);
    if (mobileEl.value !== next) mobileEl.value = next;
  });
  mobileEl?.addEventListener("paste", (ev) => {
    ev.preventDefault();
    const text = ev.clipboardData?.getData("text") || "";
    mobileEl.value = keepDigits(`${mobileEl.value}${text}`, PROFILE_MOBILE_MAX_LENGTH);
  });

  ageEl?.addEventListener("input", () => {
    const digits = keepDigits(ageEl.value, 3);
    if (!digits) {
      ageEl.value = "";
      return;
    }
    const numeric = Math.min(PROFILE_AGE_MAX, Math.max(PROFILE_AGE_MIN, Number.parseInt(digits, 10)));
    ageEl.value = String(numeric);
  });

  nameEl?.addEventListener("input", () => {
    const next = clampTextLength(nameEl.value, PROFILE_NAME_MAX_LENGTH);
    if (nameEl.value !== next) nameEl.value = next;
  });
  siteEl?.addEventListener("input", () => {
    const next = clampTextLength(siteEl.value, PROFILE_SITE_MAX_LENGTH);
    if (siteEl.value !== next) siteEl.value = next;
  });
  locationEl?.addEventListener("input", () => {
    const next = clampTextLength(locationEl.value, PROFILE_LOCATION_MAX_LENGTH);
    if (locationEl.value !== next) locationEl.value = next;
  });
}

function displayName(userLike) {
  const name = (userLike?.name || "").trim();
  if (name) return name;
  const email = (userLike?.email || "").trim();
  if (email) return email.split("@")[0];
  return "User";
}

function renderProfileForm(data) {
  const badgeClass =
    data.role === "admin" ? "pn-profile-badge pn-profile-badge--admin" : "pn-profile-badge pn-profile-badge--user";
  const avatar = avatarHtml(data);
  const { code: mobileCode, national: mobileNational } = splitMobile(data.mobile);
  const countryValue = mobileCode || "+91";
  return `
    <div class="pn-profile-premium">
      <div class="pn-profile-hero">
        <div class="pn-profile-avatar-xl-wrap">
          <button type="button" class="pn-profile-avatar-xl" id="pf-header-avatar" aria-label="View profile photo full size" title="View photo">
            ${avatar}
          </button>
          <button type="button" class="pn-profile-avatar-edit" id="pf-photo-trigger" aria-label="Change profile photo" title="Change photo">
            ${EDIT_CAMERA_SVG}
          </button>
          <input type="file" id="pf-photo-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
        </div>
        <div class="pn-profile-hero-text">
          <div class="pn-profile-hero-name" id="pf-header-name">${escHtml(displayName(data))}</div>
          <div class="pn-profile-hero-email" id="pf-header-email">${escHtml(data.email || "")}</div>
          <span class="${badgeClass}" id="pf-header-role">${escHtml((data.role || "user").toString())}</span>
        </div>
      </div>
      <form id="pn-profile-form">
        <section class="pn-profile-block">
          <h3 class="pn-profile-block__title">Personal information</h3>
          <div class="pn-profile-block__grid">
            <div class="pn-profile-field pn-profile-field--full">
              <label for="pf-name">Full name</label>
              <input type="text" id="pf-name" name="name" autocomplete="name"
                value="${escAttr(data.name || "")}" placeholder="Your full name" maxlength="${PROFILE_NAME_MAX_LENGTH}">
            </div>
            <div class="pn-profile-field">
              <label for="pf-gender">Gender</label>
              <select id="pf-gender" autocomplete="sex">
                <option value="" ${!data.gender ? "selected" : ""}>Select</option>
                <option value="Male" ${data.gender === "Male" ? "selected" : ""}>Male</option>
                <option value="Female" ${data.gender === "Female" ? "selected" : ""}>Female</option>
                <option value="Other" ${data.gender === "Other" ? "selected" : ""}>Other</option>
              </select>
            </div>
            <div class="pn-profile-field">
              <label for="pf-age">Age</label>
              <input type="number" id="pf-age" inputmode="numeric" min="${PROFILE_AGE_MIN}" max="${PROFILE_AGE_MAX}"
                value="${data.age != null ? escAttr(String(data.age)) : ""}" placeholder="e.g. 32">
            </div>
          </div>
        </section>
        <section class="pn-profile-block">
          <h3 class="pn-profile-block__title">Contact information</h3>
          <div class="pn-profile-block__grid">
            <div class="pn-profile-field pn-profile-field--full">
              <label for="pf-email">Email</label>
              <input type="email" id="pf-email" autocomplete="email" readonly
                value="${escAttr(data.email || "")}" placeholder="you@company.com">
            </div>
            <div class="pn-profile-field pn-profile-field--full">
              <label for="pf-mobile">Mobile number</label>
              <div class="pn-profile-phone-row">
                <select id="pf-country" aria-label="Country code">${countryOptionsHtml(countryValue)}</select>
                <input type="tel" id="pf-mobile" inputmode="tel" autocomplete="tel-national"
                  value="${escAttr(keepDigits(mobileNational, PROFILE_MOBILE_MAX_LENGTH))}" maxlength="${PROFILE_MOBILE_MAX_LENGTH}" pattern="\\d{10}" placeholder="10-digit mobile number">
              </div>
            </div>
          </div>
        </section>
        <section class="pn-profile-block">
          <h3 class="pn-profile-block__title">Work information</h3>
          <div class="pn-profile-block__grid">
            <div class="pn-profile-field">
              <label for="pf-site">Site</label>
              <input type="text" id="pf-site" value="${escAttr(data.site || "")}" maxlength="${PROFILE_SITE_MAX_LENGTH}" placeholder="Project or site name">
            </div>
            <div class="pn-profile-field pn-profile-field--location">
              <label for="pf-location">Location</label>
              <input type="text" id="pf-location" autocomplete="address-level2"
                value="${escAttr(data.location || "")}" maxlength="${PROFILE_LOCATION_MAX_LENGTH}" placeholder="City, region, or area" spellcheck="false">
            </div>
          </div>
        </section>
        <div class="pn-profile-actions">
          <button type="button" class="pn-profile-btn pn-profile-btn--cancel" id="pf-cancel">Cancel</button>
          <button type="submit" class="pn-profile-btn pn-profile-btn--save" id="pf-save">Save changes</button>
        </div>
        <div class="pn-profile-feedback-slot" id="pn-profile-feedback-slot" aria-live="polite" aria-atomic="true"></div>
      </form>
    </div>`;
}

async function loadAndShowProfile() {
  openProfileModal();
  clearProfileInlineFeedback();
  const body = document.getElementById("pn-profile-body");
  body.innerHTML = `<div class="pn-modal__loader">Loading…</div>`;

  try {
    const token = getToken();
    const res = await fetch("/api/auth/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("Failed to load profile");
    const data = await res.json();

    body.innerHTML = renderProfileForm(data);
    bindProfileInputGuards();

    document.getElementById("pf-cancel").addEventListener("click", closeProfileModal);
    const photoInput = document.getElementById("pf-photo-file");
    const photoTrigger = document.getElementById("pf-photo-trigger");
    const headerAvatar = document.getElementById("pf-header-avatar");
    const headerName = document.getElementById("pf-header-name");
    let pendingPhotoFile = null;
    let pendingObjectUrl = null;

    photoTrigger.addEventListener("click", (ev) => {
      ev.stopPropagation();
      photoInput.click();
    });
    headerAvatar.addEventListener("click", () => {
      const img = headerAvatar.querySelector("img");
      if (img?.src) openProfilePhotoLightbox(img.src);
      else openProfilePhotoLightbox(null, displayName(data));
    });
    photoInput.addEventListener("change", () => {
      const file = photoInput.files?.[0];
      if (!file) return;
      openPhotoCropper({
        file,
        onCancel: () => {
          photoInput.value = "";
        },
        onConfirm: (blob) => {
          photoInput.value = "";
          pendingPhotoFile = new File([blob], "profile-photo.jpg", { type: "image/jpeg" });
          if (pendingObjectUrl) URL.revokeObjectURL(pendingObjectUrl);
          pendingObjectUrl = URL.createObjectURL(pendingPhotoFile);
          headerAvatar.innerHTML = `<img src="${pendingObjectUrl}" alt="Profile photo">`;
        },
      });
    });

    document.getElementById("pf-name").addEventListener("input", (e) => {
      const v = e.target.value.trim();
      headerName.textContent = v || displayName({ name: null, email: data.email });
    });

    document.getElementById("pn-profile-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const saveBtn = document.getElementById("pf-save");
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";

      const cc = document.getElementById("pf-country").value || "+91";
      const digits = keepDigits(document.getElementById("pf-mobile").value, PROFILE_MOBILE_MAX_LENGTH);
      const combinedMobile = digits ? `${cc}${digits}` : "";
      const name = document.getElementById("pf-name").value.trim();
      const ageRaw = document.getElementById("pf-age").value.trim();
      const age = ageRaw ? Number.parseInt(ageRaw, 10) : null;
      const site = document.getElementById("pf-site").value.trim();
      const location = document.getElementById("pf-location").value.trim();

      if (name && name.length < 2) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save changes";
        showProfileInlineFeedback("Full name must be at least 2 characters", "error");
        return;
      }
      if (digits && digits.length !== PROFILE_MOBILE_MAX_LENGTH) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save changes";
        showProfileInlineFeedback("Mobile number must be exactly 10 digits", "error");
        return;
      }
      if (age !== null && (!Number.isInteger(age) || age < PROFILE_AGE_MIN || age > PROFILE_AGE_MAX)) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save changes";
        showProfileInlineFeedback("Age must be between 1 and 89", "error");
        return;
      }

      const payload = {
        name,
        mobile: combinedMobile,
        gender: document.getElementById("pf-gender").value,
        age,
        site,
        location,
      };

      try {
        let updatedPhoto = data.profile_photo || null;
        if (pendingPhotoFile) {
          const fd = new FormData();
          fd.append("photo", pendingPhotoFile);
          const photoRes = await fetch("/api/auth/profile-photo", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: fd,
          });
          if (!photoRes.ok) throw new Error("Photo upload failed");
          const photoData = await photoRes.json();
          updatedPhoto = photoData.profile_photo || null;
        }

        const putRes = await fetch("/api/auth/profile", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });

        if (!putRes.ok) throw new Error("Save failed");

        const updated = await putRes.json();

        const stored = getUser();
        stored.name = updated.name || null;
        stored.profile_photo = updatedPhoto;
        localStorage.setItem("defectra_user", JSON.stringify(stored));

        document.querySelectorAll("#nav-profile-btn").forEach((btn) => {
          btn.className = avatarButtonClass(stored);
          btn.innerHTML = avatarHtml(stored);
        });

        Object.assign(data, updated);
        data.profile_photo = updatedPhoto;
        pendingPhotoFile = null;
        photoInput.value = "";
        if (pendingObjectUrl) {
          URL.revokeObjectURL(pendingObjectUrl);
          pendingObjectUrl = null;
        }

        headerAvatar.innerHTML = avatarHtml({ ...data, profile_photo: updatedPhoto });
        headerName.textContent = displayName({ name: updated.name, email: data.email });

        const syncM = splitMobile(updated.mobile || "");
        const countryEl = document.getElementById("pf-country");
        const mobileEl = document.getElementById("pf-mobile");
        if (countryEl && mobileEl) {
          const ccode = syncM.code || "+91";
          if ([...countryEl.options].some((o) => o.value === ccode)) countryEl.value = ccode;
          else {
            const o = document.createElement("option");
            o.value = ccode;
            o.textContent = `Saved (${ccode})`;
            countryEl.insertBefore(o, countryEl.firstChild);
            countryEl.value = ccode;
          }
          mobileEl.value = syncM.national;
        }

        showProfileInlineFeedback("Profile saved successfully", "success");
        saveBtn.disabled = false;
        saveBtn.textContent = "Save changes";
      } catch {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save changes";
        showProfileInlineFeedback("Failed to save profile", "error");
      }
    });
  } catch {
    body.innerHTML = `<div class="pn-modal__empty">Could not load profile.</div>`;
  }
}

/* ── Landing page profile (shown after login, hidden on logout) ─ */
/**
 * Mounts the profile dropdown into a container on the landing page.
 * Does NOT perform auth redirect — caller is responsible for auth.
 * Safe to call multiple times (removes previous instance first).
 *
 * @param {Element} container - Wrapper element (e.g. #nav-user-pill)
 * @param {Object}  user      - { email, role }
 * @param {Object}  [opts]
 * @param {Function} opts.onLogout - Called when user clicks Log Out
 */
export function mountLandingProfile(container, user, { onLogout } = {}) {
  injectStyles();
  buildModal();
  buildProfileModal();

  container.querySelector(".pn-landing-wrapper")?.remove();

  const adminItem = user.role === "admin"
    ? `<a href="/admin/" class="nav-profile-menu__item" id="nav-admin-link"
          role="menuitem" style="text-decoration:none">
          ${ADMIN_SVG} Admin Dashboard
       </a>`
    : "";

  const wrapper = document.createElement("div");
  wrapper.className = "nav-profile pn-landing-wrapper";
  wrapper.innerHTML = `
    <button type="button" class="${avatarButtonClass(user)}" id="nav-profile-btn"
      aria-label="My profile" aria-expanded="false" aria-haspopup="true">
      ${avatarHtml(user)}
    </button>
    <div class="nav-profile-menu" id="nav-profile-menu" role="menu">
      <div class="nav-profile-menu__header">
        <div class="nav-profile-menu__name">${displayName(user)}</div>
      </div>
      <button type="button" class="nav-profile-menu__item" id="nav-myprofile-btn"
        role="menuitem">${PROFILE_SVG} My Profile</button>
      ${adminItem}
      <button type="button" class="nav-profile-menu__item" id="nav-uploads-btn"
        role="menuitem">${UPLOADS_SVG} My Uploads</button>
      <div class="nav-profile-menu__sep"></div>
      <button type="button"
        class="nav-profile-menu__item nav-profile-menu__item--danger"
        id="nav-logout-btn" role="menuitem">
        ${LOGOUT_SVG} Log Out
      </button>
    </div>`;

  container.appendChild(wrapper);

  const btn  = wrapper.querySelector("#nav-profile-btn");
  const menu = wrapper.querySelector("#nav-profile-menu");

  function setOpen(open) {
    menu.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  btn.addEventListener("click", (e) => { e.stopPropagation(); setOpen(!menu.classList.contains("is-open")); });
  document.addEventListener("click",   () => setOpen(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });

  wrapper.querySelector("#nav-admin-link")?.addEventListener("click", () => setOpen(false));

  wrapper.querySelector("#nav-myprofile-btn").addEventListener("click", () => {
    setOpen(false);
    loadAndShowProfile();
  });

  wrapper.querySelector("#nav-uploads-btn").addEventListener("click", () => {
    setOpen(false);
    loadAndShowUploads();
  });

  wrapper.querySelector("#nav-logout-btn").addEventListener("click", () => {
    setOpen(false);
    if (onLogout) {
      onLogout();
    } else {
      clearAuth();
      window.location.href = "/";
    }
  });
}

/* ── Main export ─────────────────────────────────────────────── */
/**
 * @param {Element|string|null} [target] - Optional mount target.
 *   Pass an Element, a CSS selector string, or omit to use the default
 *   `.glass-nav--dashboard .nav-actions`.
 */
export function mountProfileNav(target) {
  const token = getToken();
  const user  = getUser();

  if (!token || !user) {
    window.location.href = "/";
    return;
  }

  injectStyles();
  buildModal();
  buildProfileModal();

  const navActions =
    target instanceof Element ? target
    : typeof target === "string" ? document.querySelector(target)
    : document.querySelector(".glass-nav--dashboard .nav-actions");
  if (!navActions) return;

  const wrapper = document.createElement("div");
  wrapper.className = "nav-profile";
  wrapper.id = "nav-profile-root";
  const adminItem = user.role === "admin"
    ? `<a href="/admin/" class="nav-profile-menu__item" id="nav-admin-link" role="menuitem">
        ${ADMIN_SVG}
        Admin Dashboard
       </a>`
    : "";

  wrapper.innerHTML = `
    <button type="button" class="${avatarButtonClass(user)}" id="nav-profile-btn"
      aria-label="My profile" aria-expanded="false" aria-haspopup="true">
      ${avatarHtml(user)}
    </button>
    <div class="nav-profile-menu" id="nav-profile-menu" role="menu">
      <div class="nav-profile-menu__header">
        <div class="nav-profile-menu__name">${displayName(user)}</div>
      </div>
      <button type="button" class="nav-profile-menu__item" id="nav-myprofile-btn" role="menuitem">
        ${PROFILE_SVG}
        My Profile
      </button>
      ${adminItem}
      <button type="button" class="nav-profile-menu__item" id="nav-uploads-btn" role="menuitem">
        ${UPLOADS_SVG}
        My Uploads
      </button>
      <div class="nav-profile-menu__sep"></div>
      <button type="button" class="nav-profile-menu__item nav-profile-menu__item--danger"
        id="nav-logout-btn" role="menuitem">
        ${LOGOUT_SVG}
        Log Out
      </button>
    </div>`;

  navActions.appendChild(wrapper);

  const btn  = wrapper.querySelector("#nav-profile-btn");
  const menu = wrapper.querySelector("#nav-profile-menu");

  function setOpen(open) {
    menu.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!menu.classList.contains("is-open"));
  });

  document.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });

  wrapper.querySelector("#nav-admin-link")?.addEventListener("click", () => setOpen(false));

  wrapper.querySelector("#nav-myprofile-btn").addEventListener("click", () => {
    setOpen(false);
    loadAndShowProfile();
  });

  wrapper.querySelector("#nav-uploads-btn").addEventListener("click", () => {
    setOpen(false);
    loadAndShowUploads();
  });

  wrapper.querySelector("#nav-logout-btn").addEventListener("click", () => {
    clearAuth();
    window.location.href = "/";
  });
}
