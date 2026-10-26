/** Scoped styles using the current DSH theme tokens. */
module.exports = `.dtmp { margin: 28px 0 8px; padding-top: 24px; border-top: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.dtmp * { box-sizing: border-box; }
.dtmp-body { display: grid; gap: 20px; }
.dtmp-heading { margin: 0; font-size: 14px; font-weight: 500; line-height: 1.5; }
.dtmp-modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.dtmp-mode { position: relative; display: grid; align-content: start; gap: 8px; min-height: 112px; padding: 18px 44px 18px 18px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); background: transparent; cursor: pointer; }
.dtmp-mode:has(input:checked) { border-color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-3); }
.dtmp-mode:focus-within { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 3px; }
.dtmp-mode:has(input:disabled) { cursor: default; }
.dtmp-mode input { position: absolute; top: 20px; right: 18px; width: 17px; height: 17px; margin: 0; accent-color: var(--dsw-alias-label-primary); cursor: inherit; }
.dtmp-mode-title { font-size: 14px; line-height: 1.5; font-weight: 500; }
.dtmp-description { font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.dtmp-default { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 16px 18px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-3); }
.dtmp-default-copy { display: grid; gap: 4px; flex: 1; min-width: 180px; }
.dtmp-default-label { font-size: 13px; line-height: 1.5; font-weight: 500; }
.dtmp-default-hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dtmp-default-control { flex: 0 1 224px; min-width: 180px; max-width: 100%; }
.dtmp-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.dtmp-field { display: grid; align-content: start; gap: 8px; min-width: 0; }
.dtmp-field:last-child { grid-column: 1 / -1; }
.dtmp-field-head { display: flex; align-items: center; gap: 8px; min-height: 22px; }
.dtmp-label { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; }
.dtmp-field-control { position: relative; }
.dtmp-field-control:after { content: ''; position: absolute; right: 14px; top: 16px; width: 6px; height: 6px; border-right: 1px solid var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-label-secondary); transform: rotate(45deg); pointer-events: none; }
.dtmp-select { appearance: none; width: 100%; min-height: 42px; padding: 9px 36px 9px 12px; border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); font: inherit; font-size: 13px; line-height: 1.5; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); text-overflow: ellipsis; }
.dtmp-select:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.dtmp-select:disabled { color: var(--dsw-alias-label-tertiary); }
.dtmp-hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dtmp-reset { appearance: none; border: 0; background: none; color: var(--dsw-alias-label-secondary); padding: 2px 0 2px 6px; font: inherit; font-size: 12px; cursor: pointer; }
.dtmp-reset:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.dtmp-reset:disabled { cursor: default; opacity: 0.5; }
.dtmp-status { display: flex; align-items: center; gap: 12px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dtmp-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; margin: 0; line-height: 1.6; }
@media (hover: hover) { .dtmp-mode:hover:not(:has(input:disabled)) { border-color: var(--dsw-alias-label-secondary); } .dtmp-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); } }
@media (max-width: 680px) { .dtmp-modes, .dtmp-fields { grid-template-columns: minmax(0, 1fr); } .dtmp-mode { min-height: 96px; padding: 16px 44px 16px 16px; } .dtmp { margin-top: 20px; padding-top: 20px; } }
`
