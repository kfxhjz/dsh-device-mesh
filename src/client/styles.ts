/**
 * Stylesheet for the dsh-device-mesh browser plugin.
 *
 * Only `--dsw-*` theme tokens are used for colour, elevation, typography and
 * radii (docs/web-styling.md). Hover-only affordances live behind
 * `@media (hover: hover)`; every interactive target is at least 40px tall.
 * The one literal colour is the QR code's white plate: QR scanners require a
 * light background, and the theme's dark surface would make the code
 * unscannable.
 */

/** CSS text injected once per plugin lifetime. */
export const styles = `
.dm-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 960px;
  height: 100%;
  margin: 0 auto;
  padding: 24px 24px 48px;
  overflow-y: auto;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-s-14-font-family, var(--dsw-font-family));
  font-size: var(--dsw-font-s-14-font-size, 14px);
  line-height: var(--dsw-font-s-14-line-height, 20px);
  -webkit-font-smoothing: antialiased;
}

.dm-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px 20px;
}

.dm-header-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }

.dm-title {
  margin: 0;
  font-size: var(--dsw-font-l-20-font-size, 20px);
  line-height: var(--dsw-font-l-20-line-height, 28px);
  font-weight: var(--dsw-font-l-20-font-weight, 600);
}

.dm-subtitle {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsw-font-xs-13-font-size, 13px);
  line-height: var(--dsw-font-xs-13-line-height, 18px);
}

.dm-header-actions { display: flex; flex-wrap: wrap; gap: 8px; }

.dm-hint {
  margin: 0;
  padding: 10px 14px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsw-font-xs-13-font-size, 13px);
  line-height: var(--dsw-font-xs-13-line-height, 18px);
}

.dm-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 40px;
  min-width: 40px;
  padding: 0 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-button-elevated-fill, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-weight: 500;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}

.dm-btn:disabled { opacity: 0.55; cursor: default; }

.dm-btn.dm-btn-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary)));
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base));
}

.dm-btn.dm-btn-danger { color: var(--dsw-alias-state-error-primary); }

.dm-btn.dm-btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}

.dm-btn.dm-btn-sm { min-height: 40px; padding: 0 10px; font-size: var(--dsw-font-xs-13-font-size, 13px); }

.dm-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

.dm-btn:focus-visible,
.dm-icon-btn:focus-visible,
.dm-input:focus-visible,
.dm-link:focus-visible,
.dm-ws:focus-visible,
.dm-session:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}

.dm-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
}

.dm-card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
}

.dm-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--dsw-font-m-18-font-size, 16px);
  line-height: var(--dsw-font-m-18-line-height, 24px);
  font-weight: 600;
}

.dm-section-title {
  margin: 0;
  font-size: var(--dsw-font-m-18-font-size, 16px);
  line-height: var(--dsw-font-m-18-line-height, 24px);
  font-weight: 600;
}

.dm-card-sub {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsw-font-xs-13-font-size, 13px);
  line-height: var(--dsw-font-xs-13-line-height, 18px);
}

.dm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px 20px; }

.dm-kv { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

.dm-kv > dt {
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  line-height: var(--dsw-font-xxs-12-line-height, 16px);
}

.dm-kv > dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: var(--dsw-font-s-14-font-size, 14px);
  line-height: var(--dsw-font-s-14-line-height, 20px);
}

.dm-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }

.dm-muted { color: var(--dsw-alias-label-tertiary); }

.dm-mono {
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--dsw-font-xs-13-font-size, 13px);
  overflow-wrap: anywhere;
}

.dm-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dm-url-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }

.dm-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  line-height: var(--dsw-font-xxs-12-line-height, 16px);
  white-space: nowrap;
}

.dm-pill.dm-pill-remote {
  background: var(--dsw-alias-interactive-bg-hover-accent, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}

.dm-pill.dm-pill-count {
  min-width: 20px;
  justify-content: center;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base));
  font-weight: 600;
}

.dm-status { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.dm-status .dm-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); flex: none; }
.dm-status[data-status='online'] .dm-dot { background: var(--dsw-alias-state-success-primary); }
.dm-status[data-status='connecting'] .dm-dot { background: var(--dsw-alias-state-warn-primary); }
.dm-status[data-status='error'] .dm-dot { background: var(--dsw-alias-state-error-primary); }
.dm-status[data-status='revoked'] .dm-dot { background: var(--dsw-alias-state-error-secondary, var(--dsw-alias-state-error-primary)); }

.dm-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 12px 14px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2);
  border-left: 3px solid var(--dsw-alias-border-l3);
}

.dm-banner.dm-banner-error { border-left-color: var(--dsw-alias-state-error-primary); }
.dm-banner.dm-banner-warn { border-left-color: var(--dsw-alias-state-warn-primary); }
.dm-banner.dm-banner-success { border-left-color: var(--dsw-alias-state-success-primary); }
.dm-banner-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 240px; }
.dm-banner-title { font-weight: 600; }
.dm-banner-actions { display: flex; flex-wrap: wrap; gap: 8px; }

.dm-pending-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 10px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}
.dm-pending-item:first-of-type { border-top: 0; }

.dm-sas {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--dsw-font-m-18-font-size, 16px);
  letter-spacing: 0.08em;
}

.dm-qr-layout { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 20px; }

.dm-qr-plate {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 12px;
  border-radius: var(--dsw-radius-md);
  background: #ffffff;
  box-shadow: var(--dsw-elevation-soft, none);
}

.dm-qr-plate img,
.dm-qr-plate svg {
  display: block;
  width: 216px;
  max-width: 60vw;
  height: auto;
  image-rendering: pixelated;
}

.dm-qr-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 216px;
  max-width: 60vw;
  aspect-ratio: 1 / 1;
  border: 0.5px dashed var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsw-font-xs-13-font-size, 13px);
  text-align: center;
}

.dm-qr-side { display: flex; flex-direction: column; gap: 10px; flex: 1 1 260px; min-width: 0; }

.dm-countdown { font-variant-numeric: tabular-nums; font-weight: 600; }
.dm-countdown.dm-countdown-expired { color: var(--dsw-alias-state-error-primary); }

.dm-link-box {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2);
  min-width: 0;
}

.dm-link-box .dm-link-text {
  flex: 1 1 180px;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  line-height: var(--dsw-font-xxs-12-line-height, 16px);
}

.dm-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dm-label { color: var(--dsw-alias-label-secondary); font-weight: 500; }

.dm-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.dm-input::placeholder { color: var(--dsw-alias-label-tertiary); }
textarea.dm-input { resize: vertical; min-height: 72px; }

.dm-switch { display: inline-flex; align-items: center; gap: 10px; min-height: 40px; cursor: pointer; }
.dm-switch input { position: absolute; opacity: 0; pointer-events: none; }
.dm-switch-track {
  position: relative;
  width: 40px;
  height: 24px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3);
  transition: background 120ms ease;
  flex: none;
}
.dm-switch-track::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, var(--dsw-alias-bg-base));
  transition: transform 120ms ease;
}
.dm-switch input:checked + .dm-switch-track { background: var(--dsw-alias-state-success-primary); }
.dm-switch input:checked + .dm-switch-track::after { transform: translateX(16px); }
.dm-switch input:focus-visible + .dm-switch-track { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dm-switch input:disabled + .dm-switch-track { opacity: 0.5; }
.dm-switch-label { color: var(--dsw-alias-label-primary); }

.dm-device-list { display: flex; flex-direction: column; gap: 12px; }

.dm-device {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
}

.dm-device-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.dm-device-name { display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 600; font-size: var(--dsw-font-s-strong-14-font-size, 14px); }
.dm-device-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: var(--dsw-font-xxs-12-line-height, 16px); }
.dm-device-actions { display: flex; flex-wrap: wrap; gap: 8px; }

.dm-portal-box { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2); }

.dm-groups { display: flex; flex-direction: column; gap: 16px; }

.dm-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
}

.dm-group-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.dm-group-title { display: flex; align-items: center; gap: 8px; margin: 0; font-weight: 600; }

.dm-ws {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.dm-ws-title { font-weight: 500; overflow-wrap: anywhere; }
.dm-ws-path { color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xxs-12-font-size, 12px); line-height: var(--dsw-font-xxs-12-line-height, 16px); overflow-wrap: anywhere; }
.dm-sessions { display: flex; flex-direction: column; gap: 2px; margin: 2px 0 6px 10px; padding-left: 10px; border-left: 0.5px solid var(--dsw-alias-border-l1); }

.dm-session {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}

.dm-session-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-session-meta { display: flex; align-items: center; gap: 6px; flex: none; color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xxs-12-font-size, 12px); }
.dm-running { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); flex: none; }
.dm-unread { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary); flex: none; }

.dm-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 20px 16px; border: 0.5px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); color: var(--dsw-alias-label-secondary); }
.dm-empty-title { font-weight: 600; }

.dm-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.42));
}

.dm-modal {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(680px, calc(100vh - 40px));
  overflow: hidden;
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-panel);
}

.dm-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.dm-modal-title { margin: 0; font-size: var(--dsw-font-m-18-font-size, 16px); line-height: var(--dsw-font-m-18-line-height, 24px); font-weight: 600; }
.dm-modal-body { display: flex; flex-direction: column; gap: 14px; padding: 18px; overflow-y: auto; }
.dm-modal-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 14px 18px; border-top: 0.5px solid var(--dsw-alias-border-l1); }

.dm-video-wrap { position: relative; overflow: hidden; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); }
.dm-video { display: block; width: 100%; max-height: 320px; object-fit: cover; }
.dm-scan-hint { position: absolute; inset: auto 12px 12px; padding: 6px 10px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); font-size: var(--dsw-font-xs-13-font-size, 13px); text-align: center; }

.dm-overlay {
  position: fixed;
  left: 50%;
  bottom: 20px;
  z-index: 55;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(420px, calc(100vw - 32px));
  transform: translateX(-50%);
  pointer-events: none;
}

.dm-overlay-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2));
  box-shadow: var(--dsw-elevation-prominent, var(--dsw-elevation-panel));
  pointer-events: auto;
}

.dm-overlay-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dm-overlay-actions { display: flex; flex-wrap: wrap; gap: 8px; }

.dm-icon-wrap { position: relative; display: inline-flex; align-items: center; justify-content: center; }
.dm-panel-badge {
  position: absolute;
  top: -5px;
  right: -7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 999px;
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base));
  font-size: 9px;
  line-height: 1;
  font-weight: 700;
}

.dm-panel-badge-online {
  background: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary));
}
.dm-footer-badge-online {
  background: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary));
}

.dm-sidebar-host {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 4px 8px 6px;
  padding-top: 6px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dm-sidebar-host-head {
  display: flex;
  align-items: center;
  gap: 4px;
}
.dm-sidebar-host-title {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0 8px;
  color: var(--dsw-alias-label-secondary);
  /* Inherit the sidebar's own typography (and any DSH font setting) instead of
     introducing a second scale. */
  font: inherit;
  font-weight: 600;
  line-height: 20px;
}
.dm-sidebar-host-view {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-inline-end: 2px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dm-sidebar-host-view:hover { background: var(--dsw-alias-bg-l3); color: var(--dsw-alias-label-primary); }
.dm-sidebar-host-view[hidden] { display: none; }
.dm-view-menu { min-width: 200px; padding: 4px; }
.dm-view-section {
  padding: 6px 10px 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.dm-view-item { display: flex; align-items: center; gap: 6px; }
.dm-view-check {
  display: inline-block;
  width: 12px;
  flex: none;
  color: var(--dsw-alias-brand-primary);
}
.dm-confirm-dialog {
  width: min(360px, calc(100vw - 32px));
  padding: 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  box-shadow: var(--dsw-shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.22));
}
.dm-confirm-dialog::backdrop { background: rgba(0, 0, 0, 0.32); }
.dm-confirm-dialog-fallback {
  position: fixed;
  inset: 0;
  z-index: 60;
  height: fit-content;
  margin: auto;
}
.dm-confirm-title { display: block; font-weight: 600; }
.dm-confirm-message {
  display: block;
  margin-top: 8px;
  color: var(--dsw-alias-label-secondary);
  line-height: 1.5;
}
.dm-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.dm-sidebar-host-current {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dm-sidebar-host-current:hover { background: var(--dsw-alias-bg-l3); }
.dm-sidebar-host-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: inherit;
  font-weight: 600;
  line-height: 20px;
}

.dm-host-switch { position: relative; display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
.dm-host-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-height: 34px;
  padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-l2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}
.dm-host-button:hover { background: var(--dsw-alias-bg-l3); }
.dm-host-name { font-weight: 600; max-width: 260px; }
.dm-host-chevron { color: var(--dsw-alias-label-secondary); font-size: 11px; }
/* Keep the shell's own section header/search; replace its scrolling tree with
   a constrained remote tree so trackpad scrolling and clipping behave. */
.dm-remote-mode [class*="_listArea"] {
  display: none !important;
}
/* Add-workspace and view-options act on the local registry; hide them while a
   remote registry is shown. */
.dm-remote-mode [class*="_headerActions"] {
  display: none !important;
}
.dm-remote-workspaces {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  min-height: 0;
  max-height: max(200px, calc(100vh - 280px));
  padding: 2px 6px 8px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.dm-remote-workspaces[hidden] { display: none; }
.dm-remote-search {
  width: 100%;
  margin-top: 4px;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-l1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: var(--dsw-font-xs-12-font-size, 12px);
}
.dm-remote-search::placeholder { color: var(--dsw-alias-label-secondary); }
.dm-remote-open-hint { padding: 0 6px; font-size: var(--dsw-font-xxxs-11-font-size, 11px); line-height: 1.4; }
.dm-remote-external { flex: none; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dm-remote-head {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 6px 6px;
  flex-wrap: wrap;
}
.dm-remote-head-text { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }
.dm-remote-title {
  overflow-wrap: anywhere;
  white-space: normal;
  font: inherit;
  font-weight: 600;
  line-height: 18px;
}
.dm-remote-actions { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.dm-remote-action {
  padding: 2px 6px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: var(--dsw-font-xs-12-font-size, 12px);
  cursor: pointer;
}
.dm-remote-action:hover { background: var(--dsw-alias-bg-l3); color: var(--dsw-alias-label-primary); }
.dm-remote-action-primary { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dm-remote-status { display: flex; flex-direction: column; gap: 4px; padding: 8px 6px; }
.dm-remote-status-title { font-weight: 600; }
.dm-remote-loading { padding: 8px 6px; color: var(--dsw-alias-label-secondary); font-size: var(--dsw-font-xs-12-font-size, 12px); }
.dm-remote-ws { display: flex; flex-direction: column; gap: 1px; }
.dm-remote-ws-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}


.dm-remote-actions { display: inline-flex; align-items: center; }
.dm-remote-external-btn {
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.55;
  line-height: 1;
  padding: 2px;
  cursor: pointer;
}
.dm-remote-external-btn:hover { opacity: 1; }
.dm-remote-session-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: transparent; }
.dm-remote-session-dot-running { background: var(--dsw-alias-state-success-primary); }
.dm-remote-session-dot-unread { background: var(--dsw-alias-brand-primary); }
.dm-remote-session-dot-awaiting { background: var(--dsw-alias-state-warning-primary, var(--dsw-alias-brand-primary)); }
.dm-remote-session-time { margin-inline-start: auto; flex: none; color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xxs-12-font-size, 12px); }
.dm-remote-ws-head:hover, .dm-remote-session:hover { background: var(--dsw-alias-bg-l3); }
.dm-remote-ws-icon { flex: none; width: 14px; height: 14px; color: var(--dsw-alias-label-secondary); }
.dm-remote-ws-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.dm-remote-session {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px 4px 18px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dm-remote-session-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-remote-session-ws {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
}
.dm-remote-archived-badge {
  flex: none;
  padding: 0 4px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-l3);
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
}
.dm-remote-session-archived { opacity: 0.55; }
.dm-remote-session-active { background: var(--dsw-alias-bg-l3); }
.dm-remote-flat { display: flex; flex-direction: column; gap: 1px; }
.dm-remote-notice { padding-block: 2px; overflow-wrap: anywhere; }
.dm-remote-busy { cursor: progress; }
.dm-remote-session-meta { display: inline-flex; align-items: center; gap: 4px; flex: none; }

.dm-host-menu {
  /* Body-level menus do not inherit the sidebar scale; match DSH's 13px menu
     typography so the dropdown is not larger than the rest of the UI shell. */
  font: inherit;
  font-size: var(--dsw-font-xs-13-font-size, 13px);
  line-height: 20px;
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  min-width: 280px;
  max-width: 380px;
  padding: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  /* bg-l2 is a translucent layer; a dropdown must be opaque so native rows
     never show through it. */
  background: var(--dsw-alias-bg-base);
  box-shadow: var(--dsw-shadow-l2);
}
.dm-host-menu-dialog {
  /* Top-layer <dialog>: no z-index or stacking context can cover it. */
  inset: auto;
  margin: 0;
  color: var(--dsw-alias-label-primary);
}
.dm-host-menu-dialog::backdrop { background: transparent; }

.dm-host-menu-floating {
  /* The menu is appended to <body> by the plain-DOM sidebar bar: fixed
     positioning plus a high layer keeps it above the DSH shell in Electron. */
  position: fixed;
  top: auto;
  right: auto;
  z-index: 2147483000;
  max-height: 60vh;
  overflow-y: auto;
}

.dm-host-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dm-host-item:hover, .dm-host-item-active { background: var(--dsw-alias-bg-l3); }
.dm-host-item-text { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }
.dm-host-item-name { font-weight: 600; }
.dm-host-divider { height: 1px; margin: 6px 4px; background: var(--dsw-alias-border-l2); }
.dm-host-add {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dm-host-add:hover { background: var(--dsw-alias-bg-l3); }
.dm-host-add-plus { width: 14px; text-align: center; font-weight: 700; }
.dm-host-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-secondary); flex: none; }
.dm-host-dot-online { background: var(--dsw-alias-state-success-primary); }
.dm-host-dot-connecting { background: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary)); }
.dm-host-dot-error, .dm-host-dot-revoked { background: var(--dsw-alias-state-error-primary); }
.dm-host-dot-offline { background: var(--dsw-alias-label-secondary); }

.dm-methods { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
.dm-method {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-l2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dm-method:hover { background: var(--dsw-alias-bg-l3); }
.dm-method-disabled { opacity: 0.55; cursor: not-allowed; }
.dm-method-icon { font-size: 18px; width: 22px; text-align: center; }
.dm-method-text { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; }
.dm-method-title { font-weight: 600; }

.dm-footer-entry {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dm-footer-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-footer-entry .dm-footer-badge-online {
  /* Keep the online count green even though the base badge rule comes later. */
  background: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary));
}

.dm-footer-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base));
  font-size: var(--dsw-font-xxxs-11-font-size, 11px);
  font-weight: 700;
}

.dm-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-label-secondary);
  border-radius: 50%;
  animation: dm-spin 800ms linear infinite;
  flex: none;
}

@keyframes dm-spin { to { transform: rotate(360deg); } }

/* Running remote session: a compact version of the panel spinner. */
.dm-remote-session-spinner {
  width: 12px;
  height: 12px;
  border-width: 2px;
  border-color: var(--dsw-alias-state-success-primary);
  border-top-color: transparent;
}

@media (max-width: 720px) {
  .dm-root { padding: 16px 14px 40px; gap: 14px; }
  .dm-header { flex-direction: column; }
  .dm-header-actions { width: 100%; }
  .dm-header-actions .dm-btn { flex: 1 1 auto; }
  .dm-qr-layout { flex-direction: column; align-items: stretch; }
  .dm-qr-plate { align-self: center; }
  .dm-modal-backdrop { padding: 0; align-items: flex-end; }
  .dm-modal { width: 100%; max-height: 92vh; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .dm-device-actions .dm-btn { flex: 1 1 46%; }
}

@media (hover: hover) {
  .dm-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
  .dm-btn.dm-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill)); }
  .dm-btn.dm-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
  .dm-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .dm-footer-entry:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .dm-ws:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .dm-session:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .dm-switch:hover .dm-switch-track { background: var(--dsw-alias-border-l4); }
  .dm-switch:hover input:checked + .dm-switch-track { background: var(--dsw-alias-state-success-secondary, var(--dsw-alias-state-success-primary)); }
}

@media (prefers-reduced-motion: reduce) {
  .dm-btn,
  .dm-spinner,
  .dm-switch-track,
  .dm-switch-track::after { transition: none; animation: none; }
}
`

/** DOM id of the injected stylesheet (also used by tests/debugging). */
export const STYLE_ELEMENT_ID = 'dsh-device-mesh-styles'
