/** Based on the native TeamBoard layout; MIT attribution in THIRD_PARTY_NOTICES.md. */
module.exports = `
.dtc-board { min-width:0; padding:8px 7px; color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.45; }
.dtc-board * { box-sizing:border-box; }
.dtc-header { display:flex; flex-wrap:wrap; align-items:center; gap:4px 10px; margin:0 0 4px; font-size:13px; font-weight:500; }
.dtc-header small { color:var(--dsw-alias-label-secondary); font-size:12px; font-weight:400; }
.dtc-tasks { list-style:none; margin:0; padding:0; }
.dtc-task { min-width:0; }
.dtc-row { display:flex; align-items:flex-start; gap:6px; }
.dtc-expand { display:flex; align-items:flex-start; gap:7px; flex:1; min-width:0; margin:0; padding:7px 0; border:0; border-radius:6px; background:transparent; color:inherit; font:inherit; text-align:start; cursor:pointer; }
.dtc-subject { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dtc-subject-expanded { overflow-wrap:anywhere; white-space:pre-wrap; }
.dtc-chevron { flex:none; color:var(--dsw-alias-label-secondary); }
.dtc-dot { flex:none; width:7px; height:7px; margin:5px 2px 0; border-radius:50%; background:var(--dsw-alias-state-idle-primary); }
.dtc-dot-in_progress { background:var(--dsw-alias-brand-primary); }
.dtc-dot-completed { background:var(--dsw-alias-state-success-primary); }
.dtc-remove { flex:none; margin:3px 0 0; padding:4px 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; cursor:pointer; }
.dtc-remove:hover:not(:disabled) { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dtc-remove:disabled { opacity:.55; cursor:wait; }
.dtc-expand:focus-visible, .dtc-remove:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
.dtc-details { padding:0 0 8px 18px; color:var(--dsw-alias-label-secondary); font-size:12px; overflow-wrap:anywhere; }
.dtc-details p { margin:0 0 4px; white-space:pre-wrap; }
.dtc-error { padding:4px 0 8px; color:var(--dsw-alias-state-error-primary); font-size:12px; overflow-wrap:anywhere; }
`
