export const CSS = `
.psb-root {
  position: relative;
  height: 100%;
  min-height: 480px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.45;
  overflow: hidden;
}
.psb-root *, .psb-root *::before, .psb-root *::after { box-sizing: border-box; }
.psb-head {
  flex: 0 0 54px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.psb-title { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.psb-title b { font-size: 14px; font-weight: 600; letter-spacing: .2px; }
.psb-title span { font-size: 11.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 380px; }
.psb-head-spacer { flex: 1; }
.psb-btn {
  height: 30px;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  transition: background .12s ease, border-color .12s ease, opacity .12s ease;
}
.psb-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.psb-btn:disabled { opacity: .42; cursor: not-allowed; }
.psb-btn.primary {
  background: var(--dsw-alias-brand-primary);
  border-color: transparent;
  color: #fff;
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(24, 36, 120, .18);
}
.psb-btn.primary:hover { filter: brightness(1.05); }
.psb-btn.ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); padding: 0 8px; }
.psb-btn.ghost:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.psb-btn.small { height: 26px; padding: 0 9px; font-size: 11.5px; border-radius: 7px; }
.psb-select {
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  padding: 0 6px;
  cursor: pointer;
}
.psb-body { flex: 1; min-height: 0; display: flex; }
.psb-left {
  width: 292px; flex: 0 0 292px;
  display: flex; flex-direction: column; min-height: 0;
  border-right: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.psb-right {
  width: 336px; flex: 0 0 336px;
  display: flex; flex-direction: column; min-height: 0;
  border-left: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.psb-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
.psb-section-head {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px 8px;
  font-size: 12px; font-weight: 600; letter-spacing: .2px;
}
.psb-section-head .psb-sub { font-weight: 400; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.psb-count {
  min-width: 20px; height: 18px; padding: 0 6px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px; font-weight: 500;
}
.psb-slot-summary {
  margin: 0 12px 8px;
  padding: 8px 10px;
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  display: flex; align-items: center; gap: 8px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}
.psb-slot-summary b { color: var(--dsw-alias-brand-primary); font-size: 12.5px; }
.psb-slot-summary .psb-btn { margin-left: auto; }
.psb-search {
  margin: 0 12px 8px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px;
  padding: 0 9px;
  outline: none;
}
.psb-search:focus { border-color: var(--dsw-alias-brand-primary); }
.psb-layers { flex: 1; min-height: 0; overflow: auto; padding: 2px 8px 10px; }
.psb-layer {
  display: flex; align-items: center; gap: 4px;
  height: 26px; padding: 0 4px 0 2px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
}
.psb-layer:hover { background: var(--dsw-alias-bg-layer-2); }
.psb-layer.is-slot {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent);
}
.psb-layer.is-slot .psb-layer-name { font-weight: 600; }
.psb-layer.is-group .psb-layer-name { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.psb-layer.is-hidden .psb-layer-name { opacity: .38; text-decoration: line-through; }
.psb-layer-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.psb-layer-caret {
  width: 12px; flex: 0 0 12px; opacity: .5; font-size: 9px; text-align: center;
}
.psb-icon-btn {
  width: 22px; height: 22px; flex: 0 0 22px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 5px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 0;
  opacity: .75;
}
.psb-icon-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); opacity: 1; }
.psb-icon-btn.on { color: var(--dsw-alias-brand-primary); opacity: 1; }
.psb-layers-hint { padding: 8px 14px 12px; font-size: 11px; color: var(--dsw-alias-label-secondary); border-top: 1px solid var(--dsw-alias-border-l1); }
.psb-placeholder { padding: 24px 18px; font-size: 12px; color: var(--dsw-alias-label-secondary); }

.psb-textpanel {
  max-height: 44%;
  overflow: auto;
  border-top: 1px solid var(--dsw-alias-border-l1);
  padding: 6px 8px 10px;
}
.psb-text-head {
  display: flex; align-items: center; gap: 6px;
  padding: 2px 6px 8px;
  font-size: 11.5px; font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.psb-text-row {
  padding: 4px 6px 6px;
  border-radius: 8px;
  margin-bottom: 2px;
}
.psb-text-row:hover { background: var(--dsw-alias-bg-layer-2); }
.psb-text-line { display: flex; align-items: center; gap: 2px; min-height: 22px; }
.psb-text-name {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; color: var(--dsw-alias-label-secondary);
}
.psb-text-warn { color: #d97706; font-size: 11px; padding: 0 2px; }
.psb-text-input {
  width: 100%;
  height: 26px;
  margin-top: 2px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px;
  padding: 0 8px;
  outline: none;
}
.psb-text-input:focus { border-color: var(--dsw-alias-brand-primary); }
.psb-text-runs { margin-top: 4px; display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
.psb-text-runs-input {
  width: 100%;
  resize: vertical;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 6px 8px;
  outline: none;
}
.psb-text-runs-input:focus { border-color: var(--dsw-alias-brand-primary); }

.psb-canvas-wrap {
  position: relative;
  min-height: 420px;
  user-select: none; flex: 1; min-height: 0; overflow: hidden;
  background:
    radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent) 1px, transparent 0) 0 0 / 22px 22px,
    var(--dsw-alias-bg-layer-2);
  outline: none;
}
.psb-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
.psb-empty {
  position: absolute; inset: 0; display: grid; place-items: center; padding: 32px;
}
.psb-empty-card {
  width: min(440px, 100%);
  padding: 30px 30px 26px;
  border-radius: 16px;
  border: 1.5px dashed var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  text-align: center;
  box-shadow: 0 12px 36px rgba(15, 23, 42, .07);
}
.psb-empty-card .psb-empty-icon {
  width: 56px; height: 56px; margin: 0 auto 14px;
  display: grid; place-items: center;
  border-radius: 16px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
  color: var(--dsw-alias-brand-primary);
}
.psb-empty-card h3 { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
.psb-empty-card p { margin: 0 0 18px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.psb-toolbar {
  position: absolute; top: 12px; left: 12px; z-index: 5;
  display: flex; align-items: center; gap: 6px;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 92%, transparent);
  backdrop-filter: blur(8px);
  box-shadow: 0 4px 14px rgba(15, 23, 42, .08);
}
.psb-toolbar .psb-zoom { min-width: 46px; text-align: center; font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.psb-viewtoggle {
  position: absolute; top: 12px; right: 12px; z-index: 5;
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 92%, transparent);
  backdrop-filter: blur(8px);
  font-size: 11.5px; color: var(--dsw-alias-label-secondary);
  cursor: pointer; user-select: none;
}
.psb-hintbar {
  position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
  z-index: 5;
  padding: 5px 12px; border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 86%, transparent);
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px; white-space: nowrap;
  backdrop-filter: blur(6px);
  pointer-events: none;
}
.psb-queue { flex: 1; min-height: 0; overflow: auto; padding: 0 10px 10px; }
.psb-queue-empty {
  margin: 4px 6px; padding: 26px 16px;
  border-radius: 10px; border: 1px dashed var(--dsw-alias-border-l2);
  text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary);
  display: flex; flex-direction: column; align-items: center; gap: 8px;
}
.psb-item {
  display: flex; align-items: center; gap: 9px;
  padding: 6px; border-radius: 8px; cursor: pointer;
  border: 1px solid transparent;
  content-visibility: auto;
  contain-intrinsic-size: 52px;
}
.psb-item:hover { background: var(--dsw-alias-bg-layer-2); }
.psb-item.is-on {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 38%, transparent);
}
.psb-thumb {
  width: 38px; height: 38px; flex: 0 0 38px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  background:
    linear-gradient(45deg, color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent) 25%, transparent 25%, transparent 75%, color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent) 75%) 0 0 / 12px 12px,
    linear-gradient(45deg, color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent) 25%, transparent 25%, transparent 75%, color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent) 75%) 6px 6px / 12px 12px,
    #fff;
  object-fit: contain;
  display: block;
}
.psb-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.psb-item-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.psb-item-meta { font-size: 10.5px; color: var(--dsw-alias-label-secondary); display: flex; gap: 6px; }
.psb-item .psb-icon-btn { opacity: 0; }
.psb-item:hover .psb-icon-btn, .psb-item.is-on .psb-icon-btn { opacity: 1; }
.psb-adjust {
  flex: 0 0 auto;
  max-height: 58%;
  overflow-y: auto;
  border-top: 1px solid var(--dsw-alias-border-l1);
  padding: 10px 14px 14px;
  display: flex; flex-direction: column; gap: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.psb-adjust-head { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; }
.psb-adjust-head .psb-adjust-name { margin-left: auto; font-weight: 400; font-size: 11px; color: var(--dsw-alias-label-secondary); max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.psb-field { display: flex; flex-direction: column; gap: 4px; }
.psb-field-label { display: flex; align-items: center; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.psb-field-label span { margin-left: auto; font-variant-numeric: tabular-nums; }
.psb-seg {
  display: flex; gap: 2px; padding: 2px;
  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
.psb-seg button {
  flex: 1; height: 23px; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px; cursor: pointer; padding: 0 2px;
  white-space: nowrap;
}
.psb-seg button.is-on { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: 0 1px 2px rgba(15, 23, 42, .1); }
.psb-range-row { display: flex; align-items: center; gap: 8px; }
.psb-range-row input[type="range"] { flex: 1; accent-color: var(--dsw-alias-brand-primary); height: 18px; margin: 0; }
.psb-num {
  width: 62px; height: 26px; flex: 0 0 62px;
  border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 11.5px; padding: 0 6px; text-align: right;
  font-variant-numeric: tabular-nums;
}
.psb-num:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.psb-xy { display: flex; gap: 8px; }
.psb-xy .psb-field { flex: 1; }
.psb-actions { display: flex; gap: 6px; margin-top: 2px; }
.psb-actions .psb-btn { flex: 1; justify-content: center; }
.psb-busy {
  position: absolute; inset: 0; z-index: 40;
  display: grid; place-items: center;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 66%, transparent);
  backdrop-filter: blur(3px);
}
.psb-busy-card {
  min-width: 260px; padding: 20px 22px;
  border-radius: 14px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 18px 46px rgba(15, 23, 42, .18);
  display: flex; flex-direction: column; gap: 12px; align-items: center;
}
.psb-spinner {
  width: 26px; height: 26px; border-radius: 50%;
  border: 2.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
  border-top-color: var(--dsw-alias-brand-primary);
  animation: psb-spin .8s linear infinite;
}
@keyframes psb-spin { to { transform: rotate(360deg); } }
.psb-busy-label { font-size: 12.5px; }
.psb-progress { width: 100%; height: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.psb-progress i { display: block; height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width .18s ease; }
.psb-toast {
  position: absolute; left: 50%; top: 64px; transform: translateX(-50%);
  z-index: 60; display: flex; align-items: center; gap: 8px;
  max-width: min(560px, 80vw);
  padding: 9px 14px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 12px 30px rgba(15, 23, 42, .16);
  font-size: 12px;
}
.psb-toast.is-error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); color: var(--dsw-alias-state-error-primary); }
.psb-toast.is-ok { color: var(--dsw-alias-label-primary); }
.psb-toast .psb-toast-icon { display: inline-flex; color: var(--dsw-alias-state-success-primary); }
.psb-toast.is-error .psb-toast-icon { color: var(--dsw-alias-state-error-primary); }
.psb-toast .psb-toast-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`
