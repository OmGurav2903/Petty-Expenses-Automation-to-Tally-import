function doGet(e) {
  // The link in the "confirm this email address" email. Opening it only shows
  // the Yes / No page (Users.gs, emailVerifyPageHtml_) — it changes nothing, so
  // a mail scanner opening the link can never confirm anything. Framing is left
  // at the default (not ALLOWALL) so another site cannot embed the page.
  var verifyToken = (e && e.parameter && e.parameter.verifyEmail) ? String(e.parameter.verifyEmail) : '';
  if (verifyToken) {
    return HtmlService
      .createHtmlOutput(emailVerifyPageHtml_(verifyToken))
      .setTitle('Confirm your email address');
  }
  var page = HtmlService
    .createHtmlOutput(getAppHTML_())
    .setTitle('Rabale Petty Expense System');
  // v5: framing is left at the default, so another website cannot display the app inside its own page
  // (clickjacking). If the app is ever deliberately embedded somewhere (e.g. a Google Site), set the Script
  // Property ALLOW_EMBEDDING = yes: that restores the old behaviour with no redeploy.
  var allowEmbedding = false;
  try { allowEmbedding = PropertiesService.getScriptProperties().getProperty('ALLOW_EMBEDDING') === 'yes'; } catch (embErr) { allowEmbedding = false; }
  if (allowEmbedding) page.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  // Browser-tab icon (the T mark). Never allowed to stop the page from loading.
  try { page.setFaviconUrl(getFaviconUrl_()); } catch (favErr) { Logger.log('doGet: favicon not set: ' + favErr); }
  return page;
}
// ════════════════════════════════════════════════════════════════════════════
// SECTION 14 — HTML + CSS + JAVASCRIPT
// ════════════════════════════════════════════════════════════════════════════

function getAppHTML_() {

  // The old per-page top nav-strip (Dashboard/Approval queue/Tally
  // export/Cash Advances tabs, repeated inside every page's header)
  // was removed here (design pass, sidebar redesign): navigation between
  // those same four destinations now lives once, in the persistent
  // sidebar built further down in this function. Nothing it linked to
  // was removed — see the sidebar's data-page/data-roles items.

  // Reusable filter bar markup (date range / batch ID / voucher range /
  // voucher ID / free search) — same UI shape on the Approval dashboard,
  // Admin's voucher table, and Tally Export's voucher selection, each with
  // its own id prefix so element ids stay unique across the whole page.
  function filterBarHtml(prefix) {
    return '<div class="filter-bar">' +
      '<div class="filter-search-row">' +
        '<div class="form-group"><label>Search</label><input type="text" id="' + prefix + 'Search" placeholder="Voucher ID, employee name, vehicle, cost centre..."></div>' +
        '<button class="btn btn-primary btn-sm" id="' + prefix + 'ApplyFilters" style="width:auto;">Apply Filters</button>' +
        '<button class="btn btn-outline btn-sm" id="' + prefix + 'ClearFilters" style="width:auto;">Clear</button>' +
      '</div>' +
      '<details class="filter-collapse">' +
        '<summary>More filters</summary>' +
        '<div class="filter-bar-row">' +
          '<div class="form-group"><label>Date From</label><input type="date" id="' + prefix + 'DateFrom"></div>' +
          '<div class="form-group"><label>Date To</label><input type="date" id="' + prefix + 'DateTo"></div>' +
          '<div class="form-group"><label>Batch ID</label><select id="' + prefix + 'BatchId"><option value="">All</option></select></div>' +
          '<div class="form-group"><label>Sort By</label>' +
            '<select id="' + prefix + 'SortBy">' +
              '<option value="date_desc">Date: Newest First</option>' +
              '<option value="date_asc">Date: Oldest First</option>' +
              '<option value="amount_desc">Amount: Highest First</option>' +
              '<option value="amount_asc">Amount: Lowest First</option>' +
              '<option value="voucher_desc">Voucher No.: Highest First</option>' +
              '<option value="voucher_asc">Voucher No.: Lowest First</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
        '<div class="filter-bar-row">' +
          '<div class="form-group"><label>Voucher No. From</label><input type="number" id="' + prefix + 'VoucherFrom" placeholder="e.g. 6700"></div>' +
          '<div class="form-group"><label>Voucher No. To</label><input type="number" id="' + prefix + 'VoucherTo" placeholder="e.g. 6800"></div>' +
          '<div class="form-group"><label>Voucher ID (exact)</label><input type="text" id="' + prefix + 'VoucherId" placeholder="e.g. 6767"></div>' +
        '</div>' +
      '</details>' +
    '</div>';
  }

  // Password show/hide toggle button — inline SVG eye / eye-slash icons
  // (replacing the old emoji pair, which used a see-no-evil monkey for
  // the "hidden" state — not appropriate for a business tool). data-pw-eye
  // marks which state is currently showing, so the click handler (js
  // block, below) can swap both the input type AND the icon svg together
  // without needing to compare innerHTML strings.
  function pwEyeToggleHtml(targetId) {
    var eyeSvg = '<svg data-pw-eye="open" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>';
    var eyeOffSvg = '<svg data-pw-eye="closed" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="hidden"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 1 12s4 8 11 8a9.26 9.26 0 0 0 5.39-1.61"/><path d="M9.53 9.53a3 3 0 1 0 4.24 4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    return '<button type="button" class="pw-eye-toggle" data-pw-target="' + targetId + '" aria-label="Show password" aria-pressed="false" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:8px;color:#454B6B;display:flex;">' +
      eyeSvg + eyeOffSvg + '</button>';
  }

  var css = '' +
    // Design tokens (design pass, sidebar redesign) — single source of
    // truth for the palette/typography adopted from Petty_Expense_Redesign.
    // Every existing selector below was retargeted onto these variables
    // (or an unlisted literal that maps closely) rather than renamed, so
    // no class name any other .gs file emits HTML with had to change.
    ':root{' +
      '--bg:#EEF0FC;--surface:#FFFFFF;--border:#D9DDF0;--border-soft:#E8EBF7;' +
      '--text:#14173F;--text-soft:#454B6B;--text-mute:#5F6684;' +
      '--accent:#2E3192;--accent-dark:#1F2170;--accent-bg:#ECEEFB;--accent-bg-soft:#F5F6FD;--brand-red:#ED1C24;--field-border:#7B84A3;' +
      '--success:#2F7D5C;--success-bg:#E6F4ED;--success-border:#B9DEC9;' +
      '--warning:#B8791E;--warning-bg:#FBF0DE;--warning-border:#EBCF97;' +
      '--danger:#C0433F;--danger-bg:#FBEAE9;--danger-border:#E7BAB8;' +
      '--radius:12px;--radius-sm:8px;--shadow:0 1px 2px rgba(31,33,112,.05),0 10px 30px -14px rgba(31,33,112,.22);' +
      '--font:\'Work Sans\',-apple-system,sans-serif;--mono:\'IBM Plex Mono\',ui-monospace,monospace;' +
      '--wave:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 400 12\' preserveAspectRatio=\'none\'><path d=\'M0 6 C50 0 90 12 150 6 S250 0 300 6 S370 11 400 5\' fill=\'none\' stroke=\'%232e3192\' stroke-opacity=\'.34\' stroke-width=\'1.4\' stroke-linecap=\'round\'/></svg>");' +
      '--logo-t:url("' + getLogoTDataUri_() + '");' +
    '}' +
    '* { margin:0; padding:0; box-sizing:border-box; }' +
    'body { font-family:var(--font);' +
    '  background:var(--bg);min-height:100vh;padding:0;font-size:14.5px;line-height:1.5;color:var(--text);-webkit-font-smoothing:antialiased; }' +
    '.page{display:none}.page.active{display:block}.hidden{display:none!important}' +
    '.mono{font-family:var(--mono)}' +

    // Section 8 — smooth, restrained animations. Page/section switches
    // triggered by the .active class toggle itself (showPage() untouched),
    // buttons get hover lift + press feedback, modals get a backdrop fade
    // + box entrance driven by the existing .show toggle, dropdowns fade
    // in. Everything collapses under prefers-reduced-motion.
    '@keyframes pageFadeIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}' +
    '.page.active{animation:pageFadeIn .3s ease;}' +
    '.btn:hover{transform:translateY(-1px);}' +
    '.btn:active{transform:translateY(0) scale(.98);}' +
    '.filter-btn:hover{transform:translateY(-1px);}' +
    '@keyframes modalBoxIn{from{opacity:0;transform:scale(.96) translateY(6px);}to{opacity:1;transform:scale(1) translateY(0);}}' +
    '.modal-overlay{transition:background-color .2s ease;}' +
    '.modal-overlay.show .modal-box{animation:modalBoxIn .22s ease;}' +
    '@keyframes dropdownIn{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:translateY(0);}}' +
    '.search-select-list{animation:dropdownIn .15s ease;}' +
    '@keyframes alertIn{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:translateY(0);}}' +
    '.alert.show{animation:alertIn .2s ease;}' +
    '@media (prefers-reduced-motion:reduce){' +
      '.page.active,.modal-overlay.show .modal-box,.search-select-list,.alert.show{animation:none;}' +
      '.btn:hover,.btn:active,.filter-btn:hover{transform:none;}' +
    '}' +

    '.form-group{margin-bottom:18px}' +
    '.form-group label{display:block;font-weight:600;font-size:14.5px;color:var(--text-soft);margin-bottom:6px}' +
    '.form-group label .req{color:var(--danger);margin-left:2px}' +
    'input[type=text],input[type=email],input[type=number],input[type=date],input[type=password],select,textarea{' +
    '  width:100%;padding:10px 12px;font-size:14px;border:1px solid var(--border);border-radius:var(--radius-sm);' +
    '  font-family:inherit;color:var(--text);transition:border-color .15s,box-shadow .15s;background:var(--surface)}' +
    'input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}' +
    'input:disabled,select:disabled{background:repeating-linear-gradient(135deg,var(--border-soft) 0 6px,#F5F6FD 6px 12px);color:var(--text-mute);cursor:not-allowed;border-color:var(--border-soft)}' +
    '.lock-hint{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-mute);margin-top:5px}' +
    '.btn{padding:10px 18px;border-radius:var(--radius-sm);border:none;cursor:pointer;font-weight:600;font-size:14px;transition:all .2s}' +
    '.btn-primary{background:var(--accent);color:#fff;width:100%;padding:13px;font-size:15px}' +
    '.btn-primary:hover{background:var(--accent-dark)}.btn-primary:disabled{background:#A9AEDB;cursor:not-allowed}' +
    '.btn-success{background:var(--success);color:#fff}.btn-success:hover{background:#256349}' +
    '.btn-danger{background:var(--danger);color:#fff}.btn-danger:hover{background:#9E3532}' +
    '.btn-warning{background:var(--warning);color:#fff}.btn-warning:hover{background:#96650F}' +
    '.btn-outline{background:#fff;border:1.5px solid var(--border);color:var(--text-soft)}.btn-outline:hover{border-color:var(--accent);color:var(--accent)}' +
    '.btn-sm{padding:6px 12px;font-size:13.5px;white-space:nowrap}' +
    '.btn-remove{background:#fff;border:1.5px solid var(--danger-border);color:var(--danger)}.btn-remove:hover{background:var(--danger-bg)}' +
    '.alert{padding:12px 16px;border-radius:8px;font-size:14.5px;margin-bottom:16px;display:none}' +
    '.alert.show{display:block}' +
    '.alert-error{background:var(--danger-bg);border:1px solid var(--danger-border);color:#8B3330}' +
    '.alert-success{background:var(--success-bg);border:1px solid var(--success-border);color:#1F5B45}' +
    '.alert-warning{background:var(--warning-bg);border:1px solid var(--warning-border);color:#8A5A17}' +
    '.app-container{width:100%;margin:0}' +
    '.app-body{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:24px}' +
    '.app-body.flat{background:none;border:none;border-radius:0;padding:0}' +
    '.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}' +
    '.type-toggle{display:flex;gap:10px;margin-bottom:22px}' +
    '.type-btn{flex:1;padding:13px;border:1.5px solid var(--border);border-radius:var(--radius);background:var(--surface);cursor:pointer;text-align:center;transition:all .15s;display:flex;align-items:center;justify-content:center;gap:8px}' +
    '.type-btn:hover{border-color:var(--accent)}' +
    '.type-btn.active{border-color:var(--accent);background:var(--accent-bg)}' +
    '.type-btn .icon{display:flex;color:var(--text-soft)}.type-btn.active .icon{color:var(--accent-dark)}' +
    '.type-btn .label{font-weight:600;font-size:14px;color:var(--text-soft)}.type-btn.active .label{color:var(--accent-dark)}' +
    '.section-title{font-size:14px;font-weight:700;color:var(--text);border-bottom:1px solid var(--border-soft);padding-bottom:9px;margin-bottom:16px}' +
    '.section-block{margin-bottom:28px}' +
    '.vendor-row{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px}' +
    '.vendor-row-inner{display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:flex-end}' +
    '.gst-line-row{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px}' +
    '.gst-row-unreviewed{background:#fff;border:1.5px solid var(--warning-border);border-left:4px solid var(--warning);}' +
    '.gst-row-reviewed{background:var(--accent-bg-soft);border:1px solid var(--border);opacity:.75;}' +
    '.line-pick-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer;background:#fff;transition:border-color .15s}' +
    '.line-pick-item:hover{border-color:#A9AEDB}' +
    '.line-pick-check{margin:0;flex-shrink:0;width:16px;height:16px;accent-color:var(--accent);}' +
    '.line-pick-item.checked{background:var(--accent-bg);}' +
    '.tally-sticky-bar{position:sticky;bottom:0;background:#fff;border-top:2px solid var(--border);padding:10px 14px;display:flex;justify-content:space-between;align-items:center;margin-top:8px;border-radius:0 0 8px 8px;}' +
    '.tally-sticky-sum{font-size:13.5px;color:var(--text-soft);}' +
    '.tally-sticky-sum strong{color:var(--text);font-size:14px;}' +
    '.line-pick-vendor{flex:1;font-size:14.5px;color:var(--text)}' +
    '.line-pick-amount{font-size:14.5px;font-weight:700;text-align:right;color:var(--text)}' +
    '.gst-line-head{font-weight:600;color:var(--text);font-size:14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}' +
    '.gst-line-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}' +
    '.gst-line-toggle{display:flex;gap:8px;margin-bottom:10px}' +
    '.gst-toggle-btn{flex:1;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:#fff;font-size:14.5px;font-weight:600;color:var(--text-soft);cursor:pointer}' +
    '.gst-toggle-btn.active[data-toggle="yes"]{border-color:var(--accent);background:var(--accent-bg);color:var(--accent)}' +
    '.gst-toggle-btn.active[data-toggle="no"]{border-color:var(--success);background:var(--success-bg);color:#1F5B45}' +
    '.gst-base-readout{font-size:13.5px;color:var(--text-soft);margin-top:6px}' +
    '.gst-base-readout.negative{color:var(--danger);font-weight:600}' +
    '.gst-reviewed-tag{font-size:12.5px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--success-bg);color:#1F5B45}' +
    '.gst-unreviewed-tag{font-size:12.5px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--warning-bg);color:#8A5A17}' +
    '.total-box{background:var(--accent-bg);border:1.5px solid #C9CDEB;border-radius:var(--radius);padding:16px 20px;display:flex;justify-content:space-between;align-items:center;margin:20px 0}' +
    '.total-label{font-weight:600;color:var(--text);font-size:15px}.total-value{font-family:var(--mono);font-size:24px;font-weight:700;color:var(--accent-dark)}' +
    '.stamp-warning{background:var(--warning-bg);border:1px solid var(--warning-border);border-radius:8px;padding:10px 14px;font-size:14.5px;color:#8A5A17;display:none}' +
    '.stamp-warning.show{display:block}' +
    '.ls-box{margin-top:10px;border:1.5px solid var(--border);background:var(--accent-bg-soft);border-radius:10px;padding:10px 12px}' +
    '.ls-title{font-size:13px;font-weight:700;color:var(--text-soft);margin-bottom:8px}' +
    '.ls-chips{display:flex;flex-wrap:wrap;gap:8px}' +
    '.ls-chip{font-family:inherit;font-size:14px;font-weight:600;color:var(--accent-dark);background:#fff;border:1.5px solid var(--border);border-radius:999px;padding:7px 14px;cursor:pointer;text-align:left;line-height:1.3}' +
    '.ls-chip:hover{border-color:var(--accent)}' +
    '.ls-chip.top{border-color:var(--accent);background:var(--accent-bg)}' +
    '.ls-chip.on{background:var(--accent);border-color:var(--accent);color:#fff}' +
    '.ls-chip small{font-weight:500;opacity:.85}' +
    '.ls-note{font-size:13px;color:var(--text-soft);margin-top:8px}' +
    '.ls-note:empty{display:none}' +
    '.btn-row{display:flex;gap:12px;margin-top:24px}.btn-row .btn-primary{flex:1}' +
    '.upload-zone{border:1.5px dashed var(--border);border-radius:var(--radius);padding:24px;text-align:center;background:var(--bg);cursor:pointer;transition:all .15s}' +
    '.upload-zone:hover{border-color:var(--accent);background:var(--accent-bg-soft)}' +
    '.upload-zone .upload-text{font-size:14px;font-weight:600;color:var(--text-soft)}' +
    '.upload-zone .upload-hint{font-size:12.5px;color:var(--text-mute);margin-top:3px}' +
    '.search-select-wrap{position:relative}' +
    '.search-select-input{width:100%;padding:10px 34px 10px 12px;font-size:14px;border:1px solid var(--border);border-radius:8px;font-family:inherit;color:var(--text);background:#fff}' +
    '.search-select-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}' +
    '.search-select-chevron{position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:12.5px;color:var(--text-mute);pointer-events:none;}' +
    '.search-select-count{position:absolute;right:28px;top:50%;transform:translateY(-50%);font-size:12.5px;background:var(--accent-bg);color:var(--accent-dark);padding:1px 6px;border-radius:10px;font-weight:700;pointer-events:none;}' +
    '.search-select-list{position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid var(--border);border-radius:8px;margin-top:4px;max-height:220px;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:50}' +
    '.search-select-item{padding:9px 12px;font-size:14.5px;cursor:pointer;color:var(--text)}' +
    '.search-select-item mark{background:var(--accent-bg);color:var(--accent-dark);border-radius:2px;padding:0 1px;font-weight:700;}' +
    '.search-select-item:hover{background:var(--accent-bg)}' +
    '.search-select-empty{padding:9px 12px;font-size:14.5px;color:var(--text-mute)}' +
    '.file-list{margin-top:10px}' +
    '.file-chip{display:inline-flex;align-items:center;gap:6px;background:var(--accent-bg);color:var(--accent-dark);border-radius:6px;padding:4px 10px;font-size:13.5px;font-weight:600;margin:3px;cursor:default}' +
    '.file-chip .rm{cursor:pointer;font-size:14px;opacity:.7}.file-chip .rm:hover{opacity:1}' +
    '.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}' +
    '.filter-btn{padding:6px 14px;border:1.5px solid var(--border);background:var(--bg);border-radius:20px;cursor:pointer;font-size:13px;font-weight:600;color:var(--text-soft);transition:all .15s}' +
    '.filter-bar{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;margin-bottom:16px}' +
    '.filter-bar-row{display:flex;gap:12px;margin-bottom:10px;align-items:flex-end}' +
    '.filter-bar-row:last-child{margin-bottom:0}' +
    '.filter-bar-row .form-group{flex:1;margin-bottom:0}' +
    '.filter-bar-actions{display:flex;gap:8px;}' +
    '.filter-btn:hover{border-color:#A9AEDB}.filter-btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}' +
    '.filter-btn{position:relative}.query-alert-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--warning);margin-left:7px;vertical-align:middle}' +
    '.admin-nav-tab{padding:10px 16px;border:none;border-bottom:2.5px solid transparent;margin-bottom:-1px;background:none;cursor:pointer;font-size:14px;font-weight:600;color:var(--text-soft);transition:all .15s}' +
    '.admin-nav-tab:hover{color:var(--accent)}.admin-nav-tab.active{color:var(--accent-dark);border-bottom-color:var(--accent)}#adminTabBtns,#auditorTabBtns{gap:4px;border-bottom:1px solid var(--border);margin-bottom:20px}.admin-tab-content{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:24px}' +
    '.confirm-type-box{background:var(--danger-bg);border:1px solid var(--danger-border);border-radius:6px;padding:10px;margin:10px 0;font-size:13px;color:#8B3330;}' +
    '.confirm-type-box code{background:#fff;padding:1px 5px;border-radius:3px;font-weight:700;}' +
    '.gst-worked-example{display:flex;align-items:center;gap:10px;background:var(--accent-bg-soft);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:16px;}' +
    '.gst-worked-example .eq{font-family:ui-monospace,Menlo,monospace;font-size:13.5px;color:var(--text);font-weight:700;}' +
    '.gst-worked-example .lbl{color:var(--text-soft);font-size:12px;margin-top:2px;}' +
    '.vendor-check-inline{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-soft);background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 9px;margin-top:6px;}' +
    '.vendor-check-inline.exists{color:#8B3330;background:var(--danger-bg);border-color:var(--danger-border);font-weight:600;}' +
    '.voucher-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13.5px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}' +
    '.voucher-table th{background:#F5F6FD;padding:11px 14px;text-align:left;font-weight:700;color:var(--text-soft);font-size:12px;letter-spacing:.02em;text-transform:uppercase;border-bottom:1px solid var(--border);white-space:nowrap}' +
    '.voucher-table thead th:first-child{border-top-left-radius:9px}.voucher-table thead th:last-child{border-top-right-radius:9px}' +
    '.voucher-table td{padding:11px 14px;border-bottom:1px solid var(--border-soft);vertical-align:middle}' +
    '.voucher-table tbody tr:last-child td{border-bottom:none}' +
    '.voucher-table tr:hover td{background:var(--accent-bg-soft)}' +
    '.dash-card .voucher-table,.admin-tab-content .voucher-table,.modal-box .voucher-table{border:none;border-radius:0;background:none}' +
    '.dash-card .voucher-table thead th,.admin-tab-content .voucher-table thead th,.modal-box .voucher-table thead th{border-radius:0}' +
    '.amt-cell{text-align:right;font-weight:700}' +
    '.badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:12px;font-size:12.5px;font-weight:700}.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}' +
    '.badge-pending{background:var(--warning-bg);color:#8A5A17}.badge-approved{background:var(--success-bg);color:#1F5B45}' +
    '.badge-rejected{background:var(--danger-bg);color:#8B3330}.badge-query{background:var(--warning-bg);color:#8A5A17}' +
    '.action-btns{display:flex;gap:6px;white-space:nowrap;flex-wrap:wrap}' +
    '.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center}' +
    '.floating-alert-box{max-width:420px;text-align:center;padding:32px 28px;}' +
    '.floating-alert-icon{font-size:40px;margin-bottom:12px;}' +
    '.floating-alert-box.floating-alert-error .floating-alert-icon{color:var(--danger);}' +
    '.floating-alert-box.floating-alert-success .floating-alert-icon{color:var(--success);}' +
    '.floating-alert-msg{font-size:15px;color:var(--text);line-height:1.6;margin-bottom:8px;}' +
    '.modal-overlay.show{display:flex}' +
    '.modal-box{background:#fff;border:1px solid var(--border);border-radius:14px;padding:28px;width:90%;max-width:520px;max-height:90vh;overflow-y:auto}' +
    '.modal-title{font-size:18px;font-weight:700;color:var(--text);margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid var(--border)}' +
    // Severity color strip (#13, round 2) — a left-accent
    // stripe, not
    // a new visual language. Approve/Reject only \u2014 every other modal
    // (.modal-box alone, no severity-* modifier) is untouched.
    '.modal-severity{display:flex;padding:0;overflow:hidden;}' +
    '.modal-severity-strip{width:4px;flex-shrink:0;align-self:stretch;}' +
    '.modal-severity-body{padding:28px;flex:1;min-width:0;}' +
    '.modal-severity-approve .modal-severity-strip{background:var(--success);}' +
    '.modal-severity-reject .modal-severity-strip{background:var(--danger);}' +
    '.modal-title-flat{font-size:18px;font-weight:700;color:var(--text);margin-bottom:10px;}' +
    '.modal-buttons{display:flex;gap:12px;justify-content:flex-end;margin-top:20px}' +
    '.empty-state{text-align:center;padding:36px 20px;color:var(--text-mute);background:var(--bg);border:1px dashed var(--border);border-radius:10px;}.empty-state .icon{font-size:32px;margin-bottom:10px}' +
    '.empty-state .title{font-weight:700;font-size:14px;color:var(--text);margin-bottom:4px;}' +
    '.empty-state .sub{font-size:14px;color:var(--text-soft);margin-bottom:12px;}' +
    '.empty-state .sub.hidden{margin-bottom:0;}' +
    '.chip-clear{display:inline-flex;align-items:center;gap:5px;font-size:13.5px;font-weight:600;color:var(--accent);background:var(--accent-bg);padding:6px 14px;border-radius:16px;cursor:pointer;border:none;}' +
    // Daily Log (Reconciliation + Breakdown) — per explicit instruction.
    '.ca-daily-badge{font-size:11px;font-weight:700;padding:2px 7px;border-radius:9px;margin-left:6px;white-space:nowrap;}' +
    '.ca-daily-badge.badge-open{background:var(--warning-bg);color:#96650F;}' +
    '.ca-daily-badge.badge-settled{background:var(--success-bg);color:#256349;}' +
    '.ca-daily-badge.badge-flag{background:var(--danger-bg);color:#9E3532;}' +
    '.ca-daily-tag{font-size:11px;font-weight:700;padding:2px 7px;border-radius:9px;background:var(--warning-bg);color:#96650F;}' +
    '.day-card-ca{border:1px solid var(--border);border-radius:10px;margin-bottom:10px;overflow:hidden;}' +
    '.day-card-ca .day-card-ca-body{display:none;padding:0 14px 14px;border-top:1px solid var(--border-soft);}' +
    '.day-card-ca.open .day-card-ca-body{display:block;padding-top:8px;}' +
    // Ledger view status header + type pills (per explicit instruction).
    '.ca-ledger-header{background:#F5F6FD;border:1px solid var(--border-soft);border-radius:10px;padding:14px 16px;margin-bottom:14px;}' +
    '.ca-ledger-avatar{width:32px;height:32px;border-radius:50%;background:var(--accent-bg);color:var(--accent);font-size:14.5px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}' +
    '.ca-ledger-type-pill{font-size:11.5px;font-weight:700;padding:2px 7px;border-radius:8px;}' +
    '.ca-ledger-type-advance{background:var(--warning-bg);color:#96650F;}' +
    '.ca-ledger-type-voucher{background:var(--success-bg);color:#256349;}' +
    '.ca-ledger-dr{color:#96650F;font-weight:600;}' +
    '.ca-ledger-cr{color:#256349;font-weight:600;}' +
    '.ca-ledger-balance.negative{color:var(--success);}' +
    '.rds-cg-batch-lines{display:none;}' +
    '.rds-cg-batch.expanded .rds-cg-batch-lines{display:block;}' +
    '.chip-clear:hover{background:#C9CDEB;}' +
    '.success-card{text-align:center;padding:32px;background:var(--bg);border:1px solid var(--border);border-radius:14px}.success-card .check{font-size:52px;margin-bottom:12px}' +
    '.success-card h2{color:var(--success);font-size:20px;margin-bottom:8px}.success-card p{color:var(--text-soft);margin-bottom:6px;font-size:14px}' +
    '.success-card .vid{font-size:24px;font-weight:700;color:var(--accent);margin:12px 0}' +

    // ADDED (design pass) — shared action-color system used by both Audit
    // Log rows and the History timeline dots, so the same action always
    // reads the same color everywhere it appears. Reuses the existing
    // badge palette (amber/teal/red) rather than inventing new hues, plus
    // one added neutral-blue for system/login-class events.
    '.act-approve{color:#1F5B45}.act-reject{color:#8B3330}.act-query{color:#8A5A17}' +
    '.act-submit{color:var(--accent)}.act-system{color:var(--text-soft)}' +
    '.act-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}' +
    '.act-dot.act-approve{background:var(--success)}.act-dot.act-reject{background:var(--danger)}' +
    '.act-dot.act-query{background:var(--warning)}.act-dot.act-submit{background:var(--accent)}' +
    '.act-dot.act-system{background:var(--text-mute)}' +

    // History timeline — vertical connector line + dot per entry,
    // replacing the old flat bordered-row list.
    '.timeline{position:relative;padding-left:22px}' +
    '.timeline::before{content:"";position:absolute;left:4px;top:6px;bottom:6px;width:2px;background:var(--border)}' +
    '.timeline-item{position:relative;padding-bottom:18px}' +
    '.timeline-item:last-child{padding-bottom:0}' +
    '.timeline-item .act-dot{position:absolute;left:-22px;top:3px;border:2px solid #fff;box-shadow:0 0 0 1px var(--border)}' +
    '.timeline-item .ti-head{font-size:14.5px}' +
    '.timeline-item .ti-when{color:var(--text-mute);font-size:12.5px;margin-left:8px;font-family:var(--mono)}' +
    '.timeline-item .ti-notes{font-size:14.5px;color:var(--text-soft);margin-top:3px}' +
    '.timeline-item.ti-query{background:var(--warning-bg);margin:0 -12px 18px;padding:10px 12px;border-radius:8px}' +
    '.timeline-item.ti-query .act-dot{left:-34px}' +

    // Audit Log — a left color bar per action category, monospace
    // timestamp, and the Voucher ID as a clickable link into History
    // (data-audhist-vid hookup is unchanged, just now rendered as a link).
    '.audit-vid-link{color:var(--accent);font-weight:700;cursor:pointer;text-decoration:underline;background:none;border:none;padding:0;font-size:inherit}' +

    // Collapsible filter panel (#14/#15) — Date/Batch/Sort/Voucher-No rows
    // roll up under a native <details>, collapsed by default; Search stays
    // outside it, always visible next to the status tabs.
    '.filter-collapse summary{cursor:pointer;font-size:14.5px;font-weight:700;color:var(--accent);padding:8px 0;list-style:none;display:flex;align-items:center;gap:6px;user-select:none}' +
    '.filter-collapse summary::-webkit-details-marker{display:none}' +
    '.filter-collapse summary::before{content:"\\25B8";display:inline-block;transition:transform .15s ease;font-size:12.5px}' +
    '.filter-collapse[open] summary::before{transform:rotate(90deg)}' +
    '.filter-search-row{display:flex;gap:10px;align-items:flex-end;margin-bottom:10px}' +
    '.filter-search-row .form-group{flex:1;margin-bottom:0}' +

    // Submit-loading overlay (#1) — small inline spinner shown over the
    // submit button area during upload, instead of just a text swap.
    // Respects reduced-motion same as the (now-removed) notif pop did.
    '.btn-spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:btnSpin .7s linear infinite;vertical-align:-3px;margin-right:8px}' +
    '@keyframes btnSpin{to{transform:rotate(360deg)}}' +
    '@media(prefers-reduced-motion:reduce){.btn-spinner{animation:none}}' +

    // Login page (#5, round 2 design pass) — de-escalated from an
    // animated hero + rotating quote to a plain teal top bar (same
    // background/weight as every page header the person sees for the
    // rest of their session) over a simple card. The SVG blobs and
    // quote rotation were pure decoration with no informational value;
    // removing them also removes the visual mismatch between an
    // elaborate one-time login screen and the flat utilitarian app that
    // follows it.
    // LOGIN PAGE styles (v3, fluid glass design). Everything is scoped to #loginPage / .lg-*, so no app style is touched.
    '/* ===== LOGIN PAGE (v3, fluid glass design). Everything is scoped to #loginPage / .lg-* so no app style is touched. ===== */' +
    '#loginPage.active{display:grid;place-items:start center;min-height:100vh;min-height:100dvh;position:relative;isolation:isolate;padding:clamp(14px,8vh,84px) clamp(14px,3vw,40px) clamp(14px,3vw,40px);overflow-x:clip}' +
    '#loginPage .hidden{display:none!important}' +
    '#loginPage .lg-sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
    '#loginPage .lg-bg{position:fixed;inset:0;z-index:-1;overflow:hidden;background:radial-gradient(60% 55% at 10% 8%,rgba(46,49,146,.20),transparent 70%),radial-gradient(50% 45% at 92% 18%,rgba(70,105,225,.16),transparent 70%),radial-gradient(55% 45% at 88% 102%,rgba(237,28,36,.12),transparent 70%),linear-gradient(160deg,#eef0fc 0%,#f7f8fd 55%,#fdf1f1 100%)}' +
    '#loginPage .lg-art{position:absolute;inset:0;width:100%;height:100%}' +
    '#loginPage .lg-art .sweep{transform-box:fill-box;transform-origin:center;animation:lgSweep 1.8s cubic-bezier(.2,.7,.2,1) both}' +
    '@keyframes lgSweep{from{transform:rotate(-170deg)}to{transform:rotate(-28deg)}}' +
    '#loginPage .lg-stage{container:lgsheet/inline-size;position:relative;width:min(1080px,100%)}' +
    '#loginPage .lg-stage::before,#loginPage .lg-stage::after{content:"";position:absolute;z-index:-1;border-radius:50%;pointer-events:none}' +
    '#loginPage .lg-stage::before{width:clamp(150px,24vw,290px);aspect-ratio:1;left:-5%;bottom:-13%;background:radial-gradient(circle at 35% 30%,#c3c8f9,#8189e8 78%);opacity:.5}' +
    '#loginPage .lg-stage::after{width:clamp(130px,20vw,240px);aspect-ratio:1;right:-3%;bottom:-15%;background:radial-gradient(circle at 35% 30%,#ffc9cc,#f27b81 80%);opacity:.46}' +
    '#loginPage .lg-sheet{--pad:clamp(20px,4.6cqi,48px);--edge:clamp(40px,8cqi,104px);--r:clamp(22px,3.4cqi,34px);--lg-line:#6c7196;position:relative;isolation:isolate;width:100%;display:grid;grid-template-columns:minmax(0,1fr)}' +
    '#loginPage .lg-sheet::before{content:"";position:absolute;inset:0;z-index:-1;border:1px solid rgba(255,255,255,.85);border-radius:var(--r);background:linear-gradient(150deg,rgba(255,255,255,.74),rgba(255,255,255,.5));-webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);box-shadow:inset 0 1px 0 #fff,0 44px 90px -46px rgba(31,33,112,.55),0 2px 10px rgba(31,33,112,.06)}' +
    '@supports not (width:1cqi){#loginPage .lg-sheet{--pad:28px;--edge:48px;--r:26px}}' +
    '@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){#loginPage .lg-sheet::before{background:rgba(255,255,255,.93)}}' +
    '@media (prefers-reduced-transparency:reduce){#loginPage .lg-sheet::before{-webkit-backdrop-filter:none;backdrop-filter:none;background:rgba(255,255,255,.95)}}' +
    '@media (forced-colors:active){#loginPage .lg-sheet::before{border-color:CanvasText}}' +
    '#loginPage .lg-brand{position:relative;z-index:0;isolation:isolate;display:flex;flex-direction:column;padding:calc(var(--pad)*.7) var(--pad) calc(var(--pad)*.4);border-radius:var(--r) var(--r) 0 0;background:linear-gradient(180deg,rgba(118,128,238,.22),rgba(118,128,238,.10))}' +
    '#loginPage.lg-drawn .lg-brand,#loginPage .lg-sheet.lg-drawn .lg-brand{background:none}' +
    '#loginPage .lg-fluid{position:absolute;z-index:-1;top:0;left:0;overflow:visible;pointer-events:none;fill:none;stroke-linecap:round}' +
    '#loginPage .lg-edge-probe{position:absolute;top:0;left:0;width:var(--edge);height:0;visibility:hidden}' +
    '#loginPage .lg-logo{display:block;width:min(clamp(190px,56cqi,380px),100%);height:auto}' +
    '#loginPage .lg-divider{display:none;height:12px;margin:clamp(14px,2.4cqi,26px) 0;background:var(--wave) no-repeat center/100% 100%}' +
    '#loginPage .lg-brand-title{margin:10px 0 0;font-size:clamp(1rem,4.4cqi,1.25rem);line-height:1.2;font-weight:700;letter-spacing:-.01em;color:var(--text)}' +
    '#loginPage .lg-brand-desc,#loginPage .lg-route{display:none}' +
    '#loginPage .lg-route{margin:auto 0 0;padding:clamp(22px,4cqi,40px) 0 0;list-style:none}' +
    '#loginPage .lg-route li{position:relative;flex:1;text-align:center}' +
    '#loginPage .lg-route li+li::before{content:"";position:absolute;top:10px;height:12px;left:calc(-50% + 24px);width:calc(100% - 48px);background:var(--wave) no-repeat center/100% 100%}' +
    '#loginPage .lg-node{display:grid;place-items:center;width:32px;height:32px;margin:0 auto 8px;font-size:14px;font-weight:700;color:var(--accent);background:rgba(255,255,255,.9);border:1.5px solid var(--accent);border-radius:50%}' +
    '#loginPage .lg-node.bull{background:radial-gradient(circle,var(--brand-red) 0 20%,#fff 20% 40%,var(--accent) 40% 62%,#fff 62%)}' +
    '#loginPage .lg-route .lbl{display:block;font-size:14px;font-weight:600;color:var(--text)}' +
    '#loginPage .lg-form{position:relative;z-index:1;align-self:center;padding:calc(var(--edge) + var(--pad)*.35) var(--pad) var(--pad)}' +
    '#loginPage .lg-inner{width:min(100%,460px);margin-inline:auto}' +
    '@container lgsheet (min-width:780px){' +
    '#loginPage .lg-sheet{grid-template-columns:minmax(0,5fr) minmax(0,6fr)}' +
    '#loginPage .lg-brand{padding:var(--pad);border-radius:var(--r) 0 0 var(--r)}' +
    '#loginPage .lg-brand-title{margin:0;max-width:16ch;font-size:clamp(1.5rem,3cqi,2rem);line-height:1.12;letter-spacing:-.02em;text-wrap:balance}' +
    '#loginPage .lg-divider{display:block}' +
    '#loginPage .lg-brand-desc{display:block;margin:clamp(8px,1.2cqi,14px) 0 0;max-width:34ch;font-size:clamp(.95rem,1.5cqi,1.05rem);color:var(--text-soft)}' +
    '#loginPage .lg-route{display:flex}' +
    '#loginPage .lg-form{padding:var(--pad) var(--pad) var(--pad) calc(var(--pad)*.35 + var(--edge))}' +
    '}' +
    '#loginPage h1.lg-title{margin:0 0 8px;font-size:clamp(1.75rem,1.2rem + 2.2cqi,2.5rem);line-height:1.1;font-weight:800;letter-spacing:-.025em;color:var(--text)}' +
    '#loginPage h1.lg-title:focus{outline:none}' +
    '#loginPage #loginFormView h1.lg-title{margin-bottom:22px}' +
    '#loginPage .lg-lead{margin:0 0 clamp(18px,3cqi,26px);font-size:1rem;color:var(--text-soft)}' +
    '#loginPage .lg-chip{display:inline-block;margin:0 0 12px;padding:3px 11px;font-size:13px;font-weight:600;color:var(--accent);background:rgba(46,49,146,.1);border-radius:999px}' +
    '#loginPage .lg-field{margin-bottom:18px}' +
    '#loginPage .lg-field>label{display:block;margin-bottom:7px;font-size:15px;font-weight:600;color:var(--text)}' +
    '#loginPage .lg-err{margin:7px 0 0;font-size:14px;font-weight:500;line-height:1.35;color:var(--danger)}' +
    '#loginPage .lg-err:empty{display:none}' +
    '#loginPage .lg-control{position:relative}' +
    '#loginPage .lg-icon{position:absolute;left:15px;top:50%;width:20px;height:20px;margin-top:-10px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;color:var(--text-soft);pointer-events:none}' +
    '#loginPage .lg-control:focus-within .lg-icon{color:var(--accent)}' +
    '#loginPage .lg-input,#loginPage .lg-control input{width:100%;height:52px;padding:0 14px 0 47px;font:inherit;font-size:16px;color:var(--text);background:rgba(255,255,255,.95);border:1.5px solid var(--lg-line);border-radius:12px;transition:border-color .15s ease,box-shadow .15s ease}' +
    '#loginPage .lg-control input:hover{border-color:var(--text-soft)}' +
    '#loginPage .lg-control input:focus,#loginPage .lg-control input:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-color:var(--accent);box-shadow:0 0 0 5px rgba(46,49,146,.12)}' +
    '#loginPage .lg-control input[aria-invalid="true"]{border-color:var(--danger);box-shadow:inset 0 0 0 1px var(--danger)}' +
    '#loginPage .lg-control input[readonly]{background:#eceef7}' +
    '#loginPage .lg-control.pw input{padding-right:54px}' +
    '#loginPage .pw-eye-toggle{position:absolute!important;top:3px!important;right:3px!important;transform:none!important;width:46px;height:46px;padding:0!important;display:grid!important;place-items:center;color:var(--text-soft)!important;border-radius:9px!important}' +
    '#loginPage .pw-eye-toggle:hover{color:var(--text)!important;background:rgba(46,49,146,.08)!important}' +
    '#loginPage .pw-eye-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}' +
    '#loginPage .pw-eye-toggle svg{width:20px;height:20px}' +
    '#loginPage .lg-hint{margin:7px 0 0;font-size:14px;font-weight:500;color:#6b4200}' +
    '#loginPage .lg-input.code,#loginPage input.lg-code{height:60px;padding:0 14px 0 calc(14px + .45em);text-align:center;font-size:26px;font-weight:700;letter-spacing:.45em;font-variant-numeric:tabular-nums}' +
    '#loginPage .lg-alert{display:flex;gap:10px;align-items:flex-start;margin-bottom:18px;padding:12px 14px;font-size:15px;line-height:1.45;border:1px solid transparent;border-radius:12px}' +
    '#loginPage .lg-alert:empty{display:none}' +
    '#loginPage .lg-alert svg{width:20px;height:20px;flex:none;margin-top:1px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}' +
    '#loginPage .lg-alert[data-kind="error"]{color:#a50f16;background:#fdecec;border-color:#f3b9bc}' +
    '#loginPage .lg-alert[data-kind="locked"]{color:#6b4200;background:#fff4e0;border-color:#f2d49b}' +
    '#loginPage .lg-alert[data-kind="success"]{color:#14532d;background:#e8f5ec;border-color:#b7dfc4}' +
    '#loginPage .lg-alert[data-kind="info"]{color:var(--accent-dark);background:#ecedfb;border-color:#c9cdeb}' +
    '#loginPage .lg-recovery{margin:-6px 0 18px;padding:12px 14px;font-size:14.5px;line-height:1.45;color:#6b4200;background:#fff4e0;border:1px solid #f2d49b;border-radius:12px}' +
    '#loginPage .lg-recovery-title{font-weight:700;margin-bottom:2px}' +
    '#loginPage .lg-btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;width:100%;height:56px;font:inherit;font-size:17px;font-weight:700;letter-spacing:.005em;color:#fff;background:var(--accent);border:0;border-radius:12px;cursor:pointer;box-shadow:0 10px 22px -10px rgba(46,49,146,.75),inset 0 1px 0 rgba(255,255,255,.18);transition:background-color .15s ease,transform .15s ease,box-shadow .15s ease}' +
    '#loginPage .lg-btn:hover{background:var(--accent-dark);transform:translateY(-1px)}' +
    '#loginPage .lg-btn:active{background:var(--accent-dark);transform:translateY(0);box-shadow:0 4px 10px -6px rgba(46,49,146,.8)}' +
    '#loginPage .lg-btn:focus-visible{outline:3px solid var(--accent);outline-offset:3px}' +
    '#loginPage .lg-btn[aria-disabled="true"]{cursor:progress;background:#5254ad;transform:none}' +
    '#loginPage .lg-spin{display:none;width:18px;height:18px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:lgSpin .8s linear infinite}' +
    '#loginPage .lg-btn[aria-busy="true"] .lg-spin{display:inline-block}' +
    '@keyframes lgSpin{to{transform:rotate(360deg)}}' +
    '#loginPage .lg-link{display:inline-flex;align-items:center;min-height:44px;padding:0 2px;font:inherit;font-weight:600;color:var(--accent);background:none;border:0;cursor:pointer;text-decoration:underline;text-underline-offset:4px}' +
    '#loginPage .lg-link:hover{color:var(--text)}' +
    '#loginPage .lg-link:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:3px}' +
    '#loginPage .lg-link:disabled{color:var(--text-soft);text-decoration:none;cursor:default}' +
    '#loginPage .lg-row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 16px;margin-top:4px}' +
    '#loginPage .lg-row.between{align-items:center;margin:-4px 0 14px}' +
    '#loginPage .lg-check{display:inline-flex;align-items:center;gap:10px;min-height:44px;font-size:15px;color:var(--text);cursor:pointer}' +
    '#loginPage .lg-check input{width:22px;height:22px;margin:0;accent-color:var(--accent);cursor:pointer}' +
    '#loginPage .lg-rules{display:grid;gap:6px;margin:-4px 0 20px;padding:0;list-style:none;font-size:14.5px;color:var(--text-soft)}' +
    '#loginPage .lg-rules li{display:flex;align-items:center;gap:10px}' +
    '#loginPage .lg-ck{position:relative;flex:none;width:18px;height:18px;border:1.5px solid var(--lg-line);border-radius:50%}' +
    '#loginPage .lg-rules li[data-met="true"]{color:var(--text);font-weight:500}' +
    '#loginPage .lg-rules li[data-met="true"] .lg-ck{background:var(--accent);border-color:var(--accent)}' +
    '#loginPage .lg-rules li[data-met="true"] .lg-ck::after{content:"";position:absolute;left:5px;top:1.5px;width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}' +
    '#loginPage .lg-help{margin:0;font-size:15px;color:var(--text-soft)}' +
    '#loginPage .lg-help strong{color:var(--text);font-weight:600}' +
    '#loginPage .lg-form .lg-divider{display:block;margin:22px 0 18px}' +
    '@media (prefers-reduced-motion:reduce){#loginPage .lg-art .sweep{animation:none;transform:rotate(-28deg)}#loginPage .lg-spin{animation-duration:1.8s}#loginPage .lg-btn,#loginPage .lg-control input{transition:none}#loginPage .lg-btn:hover{transform:none}}' +
    '@media (max-width:600px){#loginPage.active{padding-top:14px}}' +
    '@media(max-width:700px){.grid-2,.vendor-row-inner{grid-template-columns:1fr}.type-toggle{flex-direction:column}}' +

    // Voucher detail modal (#7/#8, design pass) — status header, stat
    // strip, approval-chain progress, and query/response thread block.
    '.vd-header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;margin-bottom:0;border-bottom:1px solid var(--border)}' +
    '.vd-header h3{font-size:18px;font-weight:700;color:var(--text);margin:0}' +
    '.vd-header .sub{font-size:14.5px;color:var(--text-soft);margin-top:2px}' +
    '.vd-stats{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--border)}' +
    '.vd-stat{padding:12px 0;border-right:1px solid var(--border);text-align:center}' +
    '.vd-stat:last-child{border-right:none}' +
    '.vd-stat .lbl{font-size:12.5px;color:var(--text-mute);text-transform:uppercase;letter-spacing:.03em}' +
    '.vd-stat .val{font-size:16px;font-weight:700;color:var(--text);margin-top:2px}' +
    '.vd-chain{display:flex;align-items:center;padding:16px 4px}' +
    '.vd-chain-step{flex:1;text-align:center}' +
    '.vd-chain-dot{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto;font-size:14.5px;font-weight:700}' +
    '.vd-chain-dot.done{background:var(--success-bg);color:#1F5B45}.vd-chain-dot.rejected{background:var(--danger-bg);color:#8B3330}' +
    '.vd-chain-dot.waiting{background:var(--accent-bg-soft);border:1px solid var(--border);color:var(--text-mute)}' +
    '.vd-chain-step .lbl{font-size:13.5px;font-weight:600;margin-top:5px}.vd-chain-step .sub{font-size:12.5px;color:var(--text-mute)}' +
    '.vd-chain-line{flex:1;height:2px;background:var(--border);margin-bottom:24px}' +
    '.vd-chain-line.done{background:var(--success)}' +
    '.chain-mini{display:flex;align-items:center;gap:4px;}' +
    '.status-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:12px;font-size:11.5px;font-weight:700;white-space:nowrap;}' +
    '.status-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;}' +
    '.st-l1{background:var(--warning-bg);color:#8A5A17;}.st-l1 .status-dot{background:var(--warning);}' +
    '.st-acc{background:var(--warning-bg);color:#8A5A17;}.st-acc .status-dot{background:var(--warning);}' +
    '.st-l2{background:var(--warning-bg);color:#8A5A17;}.st-l2 .status-dot{background:#96650F;}' +
    '.st-app{background:var(--success-bg);color:#1F5B45;}.st-app .status-dot{background:var(--success);}' +
    '.st-rej{background:var(--danger-bg);color:#8B3330;}.st-rej .status-dot{background:var(--danger);}' +
    '.st-qry{background:var(--warning-bg);color:#8A5A17;}.st-qry .status-dot{background:var(--warning);}' +
    '.chain-dot-mini{width:9px;height:9px;border-radius:50%;display:inline-block;background:var(--accent-bg-soft);border:1px solid var(--border);}' +
    '.chain-dot-mini.done{background:var(--success);border-color:var(--success)}' +
    '.chain-dot-mini.current{background:var(--warning);border-color:var(--warning)}' +
    '.chain-dot-mini.rejected{background:var(--danger);border-color:var(--danger)}' +
    '.chain-dot-mini.waiting{background:var(--accent-bg-soft);border-color:var(--border)}' +
    '.vd-query-block{margin:0;padding:12px 24px;background:var(--warning-bg);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}' +
    '.vd-query-block .qhead{font-size:14.5px;font-weight:700;color:#8A5A17;margin-bottom:4px}' +
    '.vd-query-block .qtext{font-size:14.5px;color:var(--text-soft);margin-bottom:8px}' +
    '.vd-response{font-size:14.5px;background:#fff;border:1px solid var(--border);border-radius:8px;padding:8px 10px}' +
    '.vd-response .meta{color:var(--text-mute);font-size:12.5px;display:block;margin-bottom:2px}' +
    '.vd-section{padding:14px 24px}' +
    '.vd-row{display:flex;font-size:14.5px;padding:4px 0}' +
    '.vd-row .k{width:150px;flex-shrink:0;font-weight:600;color:var(--text-soft)}' +
    '.vd-row .v{color:var(--text)}' +
    '.vd-bills{display:flex;gap:8px;flex-wrap:wrap}' +
    '.vd-bill-chip{display:flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:14.5px;color:var(--accent);text-decoration:none;cursor:pointer;background:none}' +
    '.vd-bill-chip:hover{border-color:var(--accent);background:var(--accent-bg-soft)}' +

    // Landing dashboard (#18, design pass)
    '.dash-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}' +
    '.dash-stats-5{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:20px}' +
    '.dash-stat.accent{background:linear-gradient(135deg,var(--accent-dark),var(--accent));color:#fff;}' +
    '.dash-stat.accent .lbl{color:rgba(255,255,255,.8);}' +
    '.dash-stat.accent .val{color:#fff;}' +
    '.dash-stat.accent .sub{color:rgba(255,255,255,.75);}' +
    // Item 13 (24 Aug 2026) — generic collapse chevron button, reused
    // across every collapsible dash-card (Open Balances, Daily Log,
    // Ledger, on both the shared Cash Advances page and the Submission
    // Dashboard). Default state is always expanded on load — collapsing
    // is an explicit per-session user choice, never a hidden-by-default
    // surprise.
    '.collapse-btn{width:30px;height:30px;border:1px solid var(--border);background:var(--bg);border-radius:6px;cursor:pointer;font-size:12px;color:var(--text-soft);display:flex;align-items:center;justify-content:center;flex-shrink:0;}' +
    '.collapse-btn:hover{background:var(--border-soft);}' +
    '.qfs-locked{pointer-events:none;opacity:.45;filter:grayscale(.35);}' +
    '.period-select{padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;color:var(--text);background:#fff;}' +
    '.ca-filter-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;font-size:13px;color:var(--text-soft);}' +
    '.dash-stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px}' +
    '.dash-stat .lbl{font-size:13.5px;color:var(--text-soft);font-weight:600}' +
    '.dash-stat .val{font-size:26px;font-weight:700;color:var(--accent);margin-top:4px}' +
    '.dash-stat .sub{font-size:12.5px;color:var(--text-mute);margin-top:2px}' +
    '.dash-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}' +
    '.dash-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px}' +
    '.dash-card+.dash-card{margin-top:16px}.dash-card .filters{margin-bottom:0;flex-wrap:nowrap}' +
    '.dash-card-title{font-size:14px;font-weight:700;color:var(--text);margin-bottom:12px}' +
    '.dash-card-title-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}' +
    '.dash-card-title-row .dash-card-title{margin-bottom:0}' +
    '.dash-pie-row{display:flex;align-items:center;gap:20px}' +
    '.dash-pie-legend{font-size:13.5px}' +
    '.dash-pie-legend-item{display:flex;align-items:center;gap:6px;margin-bottom:6px}' +
    '.dash-pie-legend-swatch{width:10px;height:10px;border-radius:2px;flex-shrink:0}' +
    '#submissionDashboardPage .dash-grid{margin-bottom:16px}' +
    '#submissionDashboardPage .dash-grid>.dash-card{margin-top:0}' +
    '.dash-note{font-size:12.5px;color:var(--text-mute);margin-top:10px;line-height:1.45}' +
    '.sd-empty{padding:18px 4px;color:var(--text-mute);font-size:13.5px}' +
    '.sd-att-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border-soft);font-size:13.5px}' +
    '.sd-att-row:last-of-type{border-bottom:none}' +
    '.sd-att-row .id{font-weight:700;color:var(--text);min-width:64px}' +
    '.sd-att-row .meta{flex:1;min-width:0;color:var(--text-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.sd-att-row .amt{font-weight:600;color:var(--text);white-space:nowrap}' +
    '.sd-bar-row{display:grid;grid-template-columns:150px 1fr 44px;gap:10px;align-items:center;margin-bottom:10px;font-size:13.5px}' +
    '.sd-bar-row .nm{color:var(--text-soft);font-weight:600}' +
    '.sd-bar{height:10px;background:var(--border-soft);border-radius:6px;overflow:hidden}' +
    '.sd-bar>i{display:block;height:100%;border-radius:6px}' +
    '.sd-bar-row .ct{text-align:right;font-weight:700;color:var(--text)}' +
    '@media(max-width:900px){.dash-stats{grid-template-columns:1fr 1fr}.dash-stats-5{grid-template-columns:1fr 1fr}.dash-grid{grid-template-columns:1fr}}' +

    // ===== Persistent sidebar shell (design pass, sidebar redesign) =====
    // Wraps every authenticated .page div (loginPage stays outside it).
    // Shown/hidden as one unit via #appShell — see routeToRolePage/
    // doLogout in the JS section — independent of individual .page
    // active-state toggling, which is untouched.
    '.shell{display:flex;min-height:100vh;align-items:flex-start}' +
    '.shell.hidden{display:none}' +
    '.sidebar{width:236px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0;position:sticky;top:0;height:100vh;height:100dvh;align-self:flex-start}' +
    '.sb-brand{padding:20px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border-soft)}' +
    '.sb-logo{width:36px;height:36px;border-radius:50%;flex-shrink:0;background:var(--logo-t) center/contain no-repeat}' +
    '.sb-brand .name{font-size:14px;font-weight:700;line-height:1.25;color:var(--text)}' +
    '.sb-brand .name small{display:block;font-weight:400;color:var(--text-mute);font-size:11px}' +
    '.sb-nav{flex:1;padding:12px;overflow-y:auto}' +
    '.sb-item{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:8px;color:var(--text-soft);font-size:14px;font-weight:500;cursor:pointer;margin-bottom:2px}' +
    '.sb-item:hover{background:var(--accent-bg-soft);color:var(--accent-dark)}' +
    '.sb-item.active{background:var(--accent-bg);color:var(--accent-dark);font-weight:600}' +
    '.sb-item svg{flex-shrink:0;opacity:.85}.sb-item.active svg{opacity:1}' +
    '.sb-section-label{font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--text-mute);text-transform:uppercase;padding:14px 10px 6px}' +
    '.sb-foot-btn svg{display:block}' +
    '.sb-foot{padding:14px 12px;border-top:1px solid var(--border-soft);display:flex;align-items:center;gap:8px}' +
    '.sb-avatar{width:34px;height:34px;border-radius:50%;background:var(--accent-bg);color:var(--accent-dark);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0}' +
    '.sb-foot .who{flex:1;min-width:0}' +
    '.sb-foot .who .n{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}' +
    '.sb-foot .who .r{font-size:11.5px;color:var(--text-mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.sb-foot-actions{display:flex;gap:4px;flex-shrink:0}' +
    '.sb-foot-btn{background:none;border:none;color:var(--text-mute);cursor:pointer;padding:5px;border-radius:6px;font-size:12.5px}' +
    '.sb-foot-btn:hover{background:var(--accent-bg-soft);color:var(--accent-dark)}' +
    '.main{flex:1;min-width:0;padding:28px 36px;max-width:1240px}' +
    '.page-head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:20px;gap:16px;flex-wrap:wrap}' +
    '.page-head h1{font-size:21px;font-weight:700;color:var(--text)}' +
    '.page-head .sub{color:var(--text-soft);font-size:14px;margin-top:3px}' +
    '.page-head-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.page-head-actions .filters{margin-bottom:0}' +
    '@media(max-width:900px){.sidebar{width:64px}.sb-brand{padding:20px 0}.sb-brand .name,.sb-item span.lbl,.sb-foot .who{display:none}.sb-brand{justify-content:center}.sb-item{justify-content:center}.main{padding:20px}}' +

    // ===== THEME v3 (app-wide) =====
    '/* ===== THEME v3: the logo palette and the login page\'s look, applied across the app (tokens above do most of the work) ===== */' +
    'body{background:linear-gradient(160deg,#EEF0FC 0%,#F7F8FD 55%,#FDF1F1 100%) fixed;background-color:var(--bg)}' +
    'h1,h2,h3{letter-spacing:-.015em}' +
    ':focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
    'input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}' +
    'input[type=text],input[type=email],input[type=number],input[type=date],input[type=password],select,textarea,.search-select-input{border:1.5px solid var(--field-border);border-radius:var(--radius-sm)}' +
    'input:focus,select:focus,textarea:focus,.search-select-input:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(46,49,146,.14)}' +
    'input:disabled,select:disabled{border-color:var(--border)}' +
    '.btn{border-radius:10px}' +
    '.btn-primary{box-shadow:0 8px 18px -10px rgba(46,49,146,.7)}' +
    '.btn-primary:disabled{box-shadow:none}' +
    '.btn-outline{border-color:#B9BEDB}' +
    '.btn-outline:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-bg-soft)}' +
    '.dash-card,.dash-stat,.app-body,.admin-tab-content,.filter-bar{border-radius:14px;box-shadow:var(--shadow)}' +
    '.app-body.flat{box-shadow:none;border-radius:0}' +
    '.dash-stat .val,.amt-cell,.total-value{font-variant-numeric:tabular-nums}' +
    '.modal-overlay{background:rgba(20,23,63,.45);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}' +
    '.modal-box{border-radius:18px;box-shadow:0 30px 70px -30px rgba(20,23,63,.6)}' +
    '.voucher-table th{background:#F1F2FB;color:var(--text-soft)}' +
    '.page-head{position:relative;margin-bottom:24px}' +
    '.page-head h1{font-size:24px;font-weight:800;letter-spacing:-.02em}' +
    '.sidebar{background:rgba(255,255,255,.88);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}' +
    '.sb-brand{position:relative;border-bottom:none;padding-bottom:20px}' +
    '.sb-item{border-radius:10px;position:relative}' +
    '.sb-item.active::before{content:"";position:absolute;left:-12px;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--brand-red)}' +
    '.sb-avatar{background:var(--accent);color:#fff}' +
    '.sb-foot-btn{padding:8px;border-radius:8px}' +
    '@media(max-width:900px){.sb-foot{flex-direction:column;gap:6px;padding:12px 6px}.sb-foot-actions{flex-direction:column;gap:2px}}' +
    '.logout-box{max-width:420px;text-align:center;padding:30px 28px}' +
    '.logout-icon{width:56px;height:56px;margin:0 auto 14px;border-radius:50%;display:grid;place-items:center;background:var(--accent-bg);color:var(--accent)}' +
    '.logout-text{font-size:15px;color:var(--text-soft);line-height:1.55;margin:8px 0 6px}' +
    '.logout-box .modal-buttons{justify-content:center;margin-top:22px}' +
    '.btn.logout-go{color:var(--danger);border-color:var(--danger-border)}' +
    '.btn.logout-go:hover{background:var(--danger-bg);border-color:var(--danger);color:var(--danger)}' +
    '.user-session-chip{margin-left:6px}';

  // Optional Script Property SUPPORT_CONTACT (e.g. "Meena Rao, ext. 214") names who to contact; without it the login page says "your administrator".
  var supportContact_ = getSupportContactText_();
  var loginSupportHtml = supportContact_ ? 'New here or locked out? Contact <strong>' + emailEsc_(supportContact_) + '</strong>.' : 'New here or locked out? Ask your administrator.';

  var body = '' +

  // LOGIN PAGE (v3, fluid glass design): three views (log in / forgot password / new password) on one glass card.
  '<div id="loginPage" class="page active">' +
  '<div class="lg-bg" aria-hidden="true"><svg class="lg-art" viewBox="0 0 1440 900" preserveAspectRatio="xMaxYMax slice" focusable="false"><defs><path id="lgWave" d="M-40 0 C 140 -46, 300 46, 480 0 S 820 -46, 1000 0 S 1340 46, 1520 0"/></defs>' +
  '<g fill="none" stroke="#2e3192" stroke-width="1.2" stroke-linecap="round" transform="translate(0 700)"><use href="#lgWave" stroke-opacity=".20"/><use href="#lgWave" transform="translate(0 20)" stroke-opacity=".16"/><use href="#lgWave" transform="translate(0 40)" stroke-opacity=".12"/><use href="#lgWave" transform="translate(0 60)" stroke-opacity=".09"/><use href="#lgWave" transform="translate(0 80)" stroke-opacity=".06"/></g>' +
  '<g fill="none" stroke="#2e3192" stroke-width="1.1" stroke-linecap="round" transform="translate(0 96) scale(1 .6)"><use href="#lgWave" stroke-opacity=".15"/><use href="#lgWave" transform="translate(0 26)" stroke-opacity=".09"/></g>' +
  '<g transform="translate(1190 200)" fill="none" stroke="#2e3192" stroke-width="1.2"><circle r="44" stroke-opacity=".18"/><circle r="88" stroke-opacity=".15"/><circle r="132" stroke-opacity=".12"/><circle r="176" stroke-opacity=".10"/><circle r="220" stroke-opacity=".08"/><circle r="264" stroke-opacity=".06"/><circle class="sweep" r="132" stroke="#ed1c24" stroke-width="2.2" stroke-opacity=".7" stroke-linecap="round" stroke-dasharray="150 700"/><circle r="4" fill="#ed1c24" stroke="none" fill-opacity=".85"/></g></svg></div>' +
  '<div class="lg-stage"><div class="lg-sheet" id="loginSheet">' +
  '<header class="lg-brand" id="loginBrand">' +
  '<svg class="lg-fluid" id="loginFluid" aria-hidden="true" focusable="false"></svg><i class="lg-edge-probe" id="loginEdgeProbe" aria-hidden="true"></i>' +
  '<img class="lg-logo" width="1000" height="161" src="' + getLogoFullDataUri_() + '" alt="Target Learning Ventures Pvt. Ltd. - Transforming lives through learning">' +
  '<div class="lg-divider" aria-hidden="true"></div>' +
  '<div class="lg-brand-copy"><div class="lg-brand-title">Rabale Petty Expense System</div><p class="lg-brand-desc">Petty cash vouchers and approvals for the Rabale operation.</p></div>' +
  '<ol class="lg-route" aria-label="Approval route"><li><span class="lg-node">1</span><span class="lbl">Submit</span></li><li><span class="lg-node">2</span><span class="lbl">L1</span></li><li><span class="lg-node">3</span><span class="lbl">Accounts</span></li><li><span class="lg-node bull" aria-hidden="true"></span><span class="lbl">L2 (final)</span></li></ol>' +
  '</header>' +
  '<main class="lg-form"><div class="lg-inner">' +
  '<section id="loginFormView" aria-labelledby="loginTitle">' +
  '<h1 id="loginTitle" class="lg-title" tabindex="-1">Log in</h1>' +
  '<div id="loginAlert" class="lg-alert" role="alert"></div>' +
  '<div id="loginRecovery" class="lg-recovery hidden" role="status"><div class="lg-recovery-title">Locked out?</div><div>You can set a new password yourself with a code sent to your email address, or ask your administrator to unlock your account.</div><button type="button" class="lg-link" id="loginRecoveryResetBtn">Reset password with an email code</button></div>' +
  '<div id="loginTakeover" class="lg-recovery hidden" role="status"><div class="lg-recovery-title">Admin override</div><div>Someone is logged in as Admin. As Admin you can end that session and continue. The other person is logged out at once.</div><button type="button" class="lg-link" id="loginTakeoverBtn">End the other Admin session and log in</button></div>' +
  '<div class="lg-field"><label for="loginUsername">Username</label><div class="lg-control"><svg class="lg-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3.2"/><path d="M3.5 17c.8-3.2 3.3-4.8 6.5-4.8s5.7 1.6 6.5 4.8"/></svg><input type="text" id="loginUsername" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next"></div><p class="lg-err" id="loginUsernameErr"></p></div>' +
  '<div class="lg-field"><label for="loginPassword">Password</label><div class="lg-control pw"><svg class="lg-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="9" width="12" height="8" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/></svg><input type="password" id="loginPassword" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go">' + pwEyeToggleHtml('loginPassword') + '</div><p class="lg-err" id="loginPasswordErr"></p><p id="loginCaps" class="lg-hint hidden" role="status">Caps Lock is on.</p></div>' +
  '<div class="lg-row between"><label class="lg-check"><input type="checkbox" id="loginRemember"> Remember my username</label><button type="button" class="lg-link" id="loginForgotBtn">Forgot password?</button></div>' +
  '<button class="lg-btn" id="loginBtn" type="button"><span class="lg-spin" aria-hidden="true"></span><span class="lg-btn-label">Log in</span></button>' +
  '<div class="lg-divider" aria-hidden="true"></div>' +
  '<p class="lg-help">' + loginSupportHtml + '</p>' +
  '</section>' +
  '<section id="forgotView" class="hidden" aria-labelledby="forgotTitle">' +
  '<span class="lg-chip">Step 1 of 2</span>' +
  '<h1 id="forgotTitle" class="lg-title" tabindex="-1">Reset your password</h1>' +
  '<p class="lg-lead">Enter your username. If the account has an email address on file, a 6-digit code is sent to it.</p>' +
  '<div id="forgotAlert" class="lg-alert" role="alert"></div>' +
  '<div class="lg-field"><label for="resetUsername">Username</label><div class="lg-control"><svg class="lg-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3.2"/><path d="M3.5 17c.8-3.2 3.3-4.8 6.5-4.8s5.7 1.6 6.5 4.8"/></svg><input type="text" id="resetUsername" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="send"></div><p class="lg-err" id="resetUsernameErr"></p></div>' +
  '<button class="lg-btn" id="resetSendBtn" type="button"><span class="lg-spin" aria-hidden="true"></span><span class="lg-btn-label">Send code</span></button>' +
  '<div class="lg-row"><button type="button" class="lg-link" id="forgotBackBtn">Back to log in</button></div>' +
  '<div class="lg-divider" aria-hidden="true"></div>' +
  '<p class="lg-help">No email address on file? Ask your administrator to reset your password.</p>' +
  '</section>' +
  '<section id="resetView" class="hidden" aria-labelledby="resetTitle">' +
  '<span class="lg-chip">Step 2 of 2</span>' +
  '<h1 id="resetTitle" class="lg-title" tabindex="-1">Choose a new password</h1>' +
  '<p class="lg-lead" id="resetStep2Hint">Enter the code we emailed you, then set a new password.</p>' +
  '<div id="resetAlert" class="lg-alert" role="alert"></div>' +
  '<div class="lg-field"><label for="resetCode">6-digit code</label><input class="lg-code" type="text" id="resetCode" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" spellcheck="false"><p class="lg-err" id="resetCodeErr"></p></div>' +
  '<div class="lg-field"><label for="resetNewPassword">New password</label><div class="lg-control pw"><svg class="lg-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="9" width="12" height="8" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/></svg><input type="password" id="resetNewPassword" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done">' + pwEyeToggleHtml('resetNewPassword') + '</div><p class="lg-err" id="resetNewPasswordErr"></p></div>' +
  '<ul class="lg-rules" id="resetRules" aria-label="Password requirements"><li data-rule="len" data-met="false"><span class="lg-ck" aria-hidden="true"></span><span>At least 8 characters</span><span class="lg-sr lg-state"> (not met)</span></li><li data-rule="mix" data-met="false"><span class="lg-ck" aria-hidden="true"></span><span>A letter and a number</span><span class="lg-sr lg-state"> (not met)</span></li></ul>' +
  '<button class="lg-btn" id="resetConfirmBtn" type="button"><span class="lg-spin" aria-hidden="true"></span><span class="lg-btn-label">Save new password</span></button>' +
  '<div class="lg-row"><button type="button" class="lg-link" id="resetResendBtn" disabled>Send a new code</button><button type="button" class="lg-link" id="resetBackBtn">Back to log in</button></div>' +
  '</section>' +
  '<section id="adminCodeView" class="hidden" aria-labelledby="adminCodeTitle">' +
  '<span class="lg-chip">Admin check</span>' +
  '<h1 id="adminCodeTitle" class="lg-title" tabindex="-1">Enter your login code</h1>' +
  '<p class="lg-lead" id="adminCodeHint">We emailed a 6-digit code to the Admin address. It works once.</p>' +
  '<div id="adminCodeAlert" class="lg-alert" role="alert"></div>' +
  '<div id="adminCodeTakeover" class="lg-recovery hidden" role="status"><div class="lg-recovery-title">Admin override</div><div>Someone is logged in as Admin. As Admin you can end that session and continue. The other person is logged out at once.</div><button type="button" class="lg-link" id="adminCodeTakeoverBtn">End the other Admin session and log in</button></div>' +
  '<div class="lg-field"><label for="adminCode">6-digit code</label><input class="lg-code" type="text" id="adminCode" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" spellcheck="false"><p class="lg-err" id="adminCodeErr"></p></div>' +
  '<button class="lg-btn" id="adminCodeBtn" type="button"><span class="lg-spin" aria-hidden="true"></span><span class="lg-btn-label">Log in</span></button>' +
  '<div class="lg-row"><button type="button" class="lg-link" id="adminCodeResendBtn" disabled>Send a new code</button><button type="button" class="lg-link" id="adminCodeBackBtn">Back to log in</button></div>' +
  '</section>' +
  '</div></main>' +
  '</div></div>' +
  '</div>' +

  // Persistent sidebar shell (design pass, sidebar redesign). Hidden until
  // login succeeds (routeToRolePage removes "hidden"), re-hidden on
  // doLogout. Every .page div below except loginPage now lives inside
  // .main instead of being a full standalone card — the .page/.active
  // show/hide mechanism (showPage()) and every id inside each page are
  // untouched. Item visibility per role and active-highlight are handled
  // in JS (updateSidebarForRole/showPage) using the exact role rules the
  // old per-page nav-strip and routeToRolePage already encoded — no
  // access that didn\'t exist before is newly exposed.
  '<div class="shell hidden" id="appShell">' +
    '<div class="sidebar">' +
      '<div class="sb-brand"><div class="sb-logo" role="img" aria-label="Target Learning Ventures"></div><div class="name">Rabale Petty Expense<small>Approval &amp; Tally System</small></div></div>' +
      '<div class="sb-nav">' +
        '<div class="sb-item" data-page="submissionDashboardPage" data-roles="submission" onclick="loadSubmissionDashboard()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg><span class="lbl">Dashboard</span></div>' +
        '<div class="sb-item" data-page="dashboardPage" data-roles="L1,accounts,L2" onclick="loadDashboard()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg><span class="lbl">Dashboard</span></div>' +
        '<div class="sb-item" data-page="submissionPage" data-roles="submission" onclick="goToNewVoucher()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg><span class="lbl">Submit Voucher</span></div>' +
        '<div class="sb-item" data-page="myVouchersPage" data-roles="submission" onclick="loadMyVouchers()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg><span class="lbl">My Vouchers</span></div>' +
        '<div class="sb-item" data-page="subRecentPage" data-roles="submission" onclick="loadSubRecentPage()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg><span class="lbl">Recent Submissions</span></div>' +
        '<div class="sb-item" data-page="subCashAdvancesPage" data-roles="submission" onclick="loadSubCashAdvancesPage()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="17" cy="14" r="1.4"/></svg><span class="lbl">Cash Advances</span></div>' +
        '<div class="sb-item" data-page="approvalPage" data-roles="L1,accounts,L2" onclick="loadApprovalDashboard()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 4 6v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg><span class="lbl">Approval Queue</span></div>' +
        '<div class="sb-item" data-page="cashAdvancesPage" data-roles="L1,accounts,L2,auditor" onclick="loadCashAdvancesPage()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="17" cy="14" r="1.4"/></svg><span class="lbl">Cash Advances</span></div>' +
        '<div class="sb-item" data-page="tallyExportPage" data-roles="accounts,admin" onclick="loadTallyExportPage()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 19V5M5 12l7-7 7 7"/></svg><span class="lbl">Tally Export</span></div>' +
        '<div class="sb-section-label" data-roles="admin,auditor">Manage</div>' +
        '<div class="sb-item" data-page="adminPage" data-roles="admin" onclick="loadAdminDashboard()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.14.62.62 1.11 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg><span class="lbl">Admin</span></div>' +
        '<div class="sb-item" data-page="auditorPage" data-roles="auditor" onclick="loadAuditorDashboard()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg><span class="lbl">Audit Log</span></div>' +
      '</div>' +
      '<div class="sb-foot">' +
        '<div class="sb-avatar" id="sbAvatar"></div>' +
        '<div class="who"><div class="n" id="sbName"></div><div class="r" id="sbRole"></div></div>' +
        '<div class="sb-foot-actions">' +
          '<button class="sb-foot-btn" id="sbChangePwBtn" title="Change Password"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/></svg></button>' +
          '<button class="sb-foot-btn" id="sbLogoutBtn" title="Log Out"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg></button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="main">' +

  // SUBMISSION PAGE
  '<div id="submissionPage" class="page">' +
    '<div class="app-container">' +
      '<div class="page-head"><div><h1>Submit Voucher</h1><div class="sub" id="submissionPageSubtitle">Regular or transport expense, with bills attached</div></div></div>' +
      '<div class="app-body">' +
        '<div id="submissionAlert" class="alert"></div>' +
        '<div id="formBody">' +
          '<div class="section-block"><div class="section-title">Expense Type</div>' +
            '<div class="type-toggle">' +
              '<div class="type-btn active" id="typeRegular"><span class="icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5"/></svg></span><span class="label">Regular Expense</span></div>' +
              '<div class="type-btn" id="typeTransport"><span class="icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 13l2-6h14l2 6v6H3z"/><circle cx="7.5" cy="19" r="1.6"/><circle cx="16.5" cy="19" r="1.6"/></svg></span><span class="label">Transport Expense</span></div>' +
            '</div></div>' +
          '<div class="section-block"><div class="section-title">Voucher Details</div>' +
            '<div class="grid-2">' +
              '<div class="form-group"><label>Voucher Date</label><input type="date" id="voucherDate" disabled title="Always today \u2014 this is when the voucher is submitted, not the bill date."><div class="lock-hint"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>Always today \u2014 locked</div></div>' +
              '<div class="form-group"><label>Voucher No. <span class="req">*</span></label><input type="text" inputmode="numeric" id="voucherNo" placeholder="e.g., 6767">' +
                '<small id="voucherNoHint" style="display:none;color:#C95C5C;font-weight:600;margin-top:4px;">This voucher number is already used this month.</small></div>' +
            '</div>' +
            '<div class="grid-2">' +
              '<div class="form-group"><label>Actual Expense Date <span class="req">*</span> <small style="font-weight:400;color:#454B6B">(date on the bill)</small></label><input type="date" id="actualExpenseDate"><small id="actualExpenseDateHint" style="display:none;color:#C95C5C;font-weight:600;margin-top:4px;">Cannot be in the future.</small></div>' +
              '<div class="form-group"></div>' +
            '</div>' +
            '<div class="grid-2">' +
              '<div class="form-group"><label>Submitted By <span class="req">*</span></label><select id="submittedBy"><option value="">-- Select employee --</option></select>' +
              '<button type="button" class="btn btn-outline btn-sm" id="requestNewEmployeeBtn" style="width:auto;margin-top:8px;">Employee not listed? Request it</button>' +
            '</div>' +
              '<div class="form-group"><label>Vehicle No. <span class="req" id="vehicleReqStar" style="display:none;">*</span> <small id="vehicleOptHint" style="font-weight:400;color:#454B6B;display:none;">(not applicable for this ledger)</small></label><select id="vehicleNo"><option value="">-- Select vehicle --</option></select></div>' +
            '</div>' +
            '<div class="form-group"><label>Cost Centre <span class="req">*</span></label><select id="costCentre"><option value="">-- Select cost centre --</option></select></div>' +
          '</div>' +
          '<div id="regularSection" class="section-block"><div class="section-title">Expense Details</div>' +
            '<div class="grid-2">' +
              '<div class="form-group"><label>Ledger / Expense Category <span class="req">*</span></label><select id="ledger"><option value="">-- Select ledger --</option></select></div>' +
              '<div class="form-group"><label>Amount (Rs.) <span class="req">*</span></label><input type="number" id="regularAmount" placeholder="0.00" min="0" step="0.01"></div>' +
            '</div>' +
            '<div class="form-group"><label>Description <span class="req">*</span></label><textarea id="regularDescription" rows="2" placeholder="What was this expense for?" maxlength="300"></textarea></div>' +
            '<div id="lsBox" class="ls-box hidden" aria-live="polite"><div class="ls-title" id="lsTitle"></div><div class="ls-chips" id="lsChips"></div><div class="ls-note" id="lsNote"></div></div>' +
          '</div>' +
          '<div id="transportSection" class="section-block hidden"><div class="section-title">Transport Vendors</div>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:14px;color:#454B6B;font-weight:600;margin-bottom:16px;cursor:pointer;">' +
              '<input type="checkbox" id="voucherReturnParcel"> This is a Return Parcel voucher' +
            '</label>' +
            '<div id="vendorsList"></div>' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">' +
              '<button type="button" class="btn btn-outline" id="addVendorBtn" style="width:auto;">+ Add Vendor</button>' +
              '<button type="button" class="btn btn-outline btn-sm" id="requestNewVendorBtn" style="width:auto;">Vendor not listed? Request it</button>' +
            '</div>' +
          '</div>' +
          '<div class="total-box"><span class="total-label">Total Amount</span><span class="total-value" id="totalDisplay">Rs. 0</span></div>' +
          '<div class="stamp-warning" id="stampWarning">&#9888;&#65039; Revenue stamp required for amounts above Rs. 5,000</div>' +
          '<div class="section-block" style="margin-top:20px;" id="wholeVoucherUploadSection">' +
            '<div class="section-title">Upload Bills <small style="font-weight:400;color:#454B6B;font-size:13.5px">(PDF or images — at least one required)</small></div>' +
            '<div id="existingFileListWrap" class="hidden">' +
              '<div style="font-size:13.5px;font-weight:600;color:#454B6B;margin-bottom:6px;">Already uploaded:</div>' +
              '<div id="existingFileList" class="file-list"></div>' +
            '</div>' +
            '<div class="upload-zone" id="uploadZone">' +
              '<input type="file" id="billFiles" multiple accept="image/jpeg,image/png,image/heic,image/heif,image/webp,application/pdf,.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp" style="display:none">' +
              '<div class="upload-text">Click to attach bills</div>' +
              '<div class="upload-hint" id="uploadHint">PDF, JPG, PNG, HEIC or WebP only | Max 25 files, 5MB each (images auto-compressed)</div>' +
            '</div>' +
            '<div id="fileList" class="file-list"></div>' +
          '</div>' +
          // Shown only when arriving here via "Respond to Query" on a
          // voucher that's still editable (Pending L1 or Rejected) — lets
          // the submitter fix the actual fields the query was about AND
          // send the response, in one save.
          '<div class="section-block hidden" id="queryResponseSection" style="border-color:#EFC98A;background:#FBEEDA;">' +
            '<div class="section-title" style="border-color:#EFC98A;">Responding to Query</div>' +
            '<div id="editQueryBox" style="background:#FBEEDA;border-radius:6px;padding:10px;font-size:14.5px;color:#454B6B;margin-bottom:12px;"></div>' +
            '<div class="form-group"><label>Your Response <span class="req">*</span></label><textarea id="editQueryResponse" rows="3" placeholder="Explain what you fixed..."></textarea></div>' +
          '</div>' +
          '<div class="section-block">' +
            '<div class="form-group" style="display:flex;gap:8px;align-items:center;">' +
              '<input type="checkbox" id="confirmSubmit" style="width:auto;">' +
              '<label for="confirmSubmit" style="margin:0;font-weight:400;">I confirm all details are correct</label>' +
            '</div>' +
          '</div>' +
          '<div class="btn-row"><button class="btn btn-primary" id="submitBtn">Submit Voucher</button></div>' +
          '<div class="btn-row" id="cancelEditRow" style="display:none;"><button class="btn btn-outline" id="cancelEditBtn">Cancel Edit</button></div>' +
        '</div>' +
        '<div id="successBody" class="hidden">' +
          '<div class="success-card">' +
            '<div class="check">&#x2705;</div><h2>Voucher Submitted!</h2>' +
            '<div class="vid" id="successVid"></div>' +
            '<p>Batch ID: <strong id="successBatch"></strong></p>' +
            '<p id="successFileNote" style="color:#3B8C6E;font-weight:600;"></p>' +
            '<p id="successFileWarning" style="color:#8A5A17;font-weight:600;"></p>' +
            '<p style="color:#5F6684;font-size:13.5px;margin-top:8px;">Voucher is now Pending L1 Approval</p>' +
            '<div style="margin-top:24px;display:flex;gap:12px;justify-content:center;">' +
              '<button class="btn btn-primary" id="submitAnotherBtn" style="width:auto;">Submit Another Voucher</button>' +
              '<button class="btn btn-outline" id="successLogoutBtn">Log Out</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>' +

  // MY VOUCHERS PAGE (Day 3) — separate landing page for the submission
  // role.
  //
  // REVISED (Day 5): previously gated behind an EMPLOYEE PICKER (nothing
  // showed until one was selected) — that picker was filtering by
  // AV.SUBMITTED_BY (the reimbursement/IOU employee), which has nothing
  // to do with who's logged in, and made the page useless as a shared
  // team view. Removed entirely; this page now shows ALL vouchers by
  // default. Individual login (Users.gs) now provides a real identity, so
  // an "All Submissions / My Submissions" toggle replaces the old picker
  // — "mine" filters by AV.SUBMITTED_BY_OPERATOR (who actually keyed the
  // voucher in), NOT by AV.SUBMITTED_BY. Permissions are unaffected by
  // this toggle — it's a view filter only, so anyone in the submission
  // role can still edit/respond-to-query on ANY voucher, covering for a
  // colleague who's out.
  '<div id="myVouchersPage" class="page">' +
    '<div class="app-container">' +
      '<div class="page-head"><div><h1>My Vouchers</h1><div class="sub">Vouchers submitted by your team</div></div><div class="page-head-actions"><div class="filters" id="myvOwnerBtns"><button class="filter-btn active" data-myv-owner="all">All Submissions</button><button class="filter-btn" data-myv-owner="mine">My Submissions</button></div></div></div>' +
      '<div class="app-body flat">' +
        '<div id="myVouchersAlert" class="alert"></div>' +
        filterBarHtml('myv') +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
          '<div class="filters" id="myvFilterBtns">' +
            '<button class="filter-btn active" data-filter="all">All</button>' +
            '<button class="filter-btn" data-filter="Pending L1">Pending L1</button>' +
            '<button class="filter-btn" data-filter="Pending Accounts">Pending Accounts</button>' +
            '<button class="filter-btn" data-filter="Pending L2">Pending L2</button>' +
            '<button class="filter-btn" data-filter="Approved">Approved</button>' +
            '<button class="filter-btn" data-filter="Rejected">Rejected</button>' +
            '<button class="filter-btn" data-filter="Query">Query<span class="query-alert-dot hidden" id="myvQueryDot" title="Unresponded queries"></span></button>' +
          '</div>' +
          '<button class="btn btn-outline btn-sm" id="myVouchersRefreshBtn" style="white-space:nowrap;">&#x21BB; Refresh</button>' +
        '</div>' +
        '<table class="voucher-table" id="myVouchersTable">' +
          '<thead><tr><th>Progress</th><th>Status</th><th>Voucher ID</th><th>Date</th><th>Expense Type</th><th>Amount</th><th>Query</th><th>Actions</th></tr></thead>' +
          '<tbody id="myVouchersBody"></tbody>' +
        '</table>' +
        '<div id="myVouchersEmptyState" class="empty-state"><div class="icon">&#x1F4EB;</div><div class="title" id="myVouchersEmptyTitle">Select an employee above to see their vouchers.</div><div class="sub hidden" id="myVouchersEmptySub"></div><span class="chip-clear hidden" id="myVouchersEmptyClearBtn">&#x2715; Clear filter and show all</span></div>' +
      '</div>' +
    '</div>' +
  '</div>' +

  // SUBMISSION LANDING DASHBOARD -- default post-login landing for the
  // submission role (see routeToRolePage). Five headline boxes, then charts and
  // short lists scoped to what this role acts on: the cash position (Cash in Hand
  // vs advances outstanding), who holds the advances, what needs the submitter's
  // attention, where their vouchers are stuck, which advances are oldest, and
  // advances given vs vouchers filed over the last 7 days. Data comes from four
  // independent server calls so a slow or failing one (e.g. the Rabale Daily Sync
  // spreadsheet) only blanks its own card. Cash Advances and Recent Submissions
  // are their own sidebar pages below; "Submit Voucher" is reached from the
  // sidebar only.
  '<div id="submissionDashboardPage" class="page">' +
  '<div class="app-container">' +
  '<div class="page-head"><div><h1>Dashboard</h1><div class="sub">Your cash advances, approvals and submissions</div></div><div class="page-head-actions"><button class="btn btn-outline btn-sm" id="subDashRefreshBtn" style="width:auto;white-space:nowrap;">&#x21BB; Refresh</button></div></div>' +
  '<div class="app-body flat">' +
  '<div id="submissionDashboardAlert" class="alert"></div>' +
        '<div class="dash-stats-5">' +
          '<div class="dash-stat accent"><div class="lbl">Cash Advances Outstanding</div><div class="val" id="subDashStatAdvances">\u2014</div><div class="sub" id="subDashStatAdvancesSub"></div></div>' +
          '<div class="dash-stat"><div class="lbl">Pending my approval</div><div class="val" id="subDashStatPending">\u2014</div><div class="sub">across L1, Accounts, L2</div></div>' +
          '<div class="dash-stat"><div class="lbl">Open queries on mine</div><div class="val" id="subDashStatQueries">\u2014</div><div class="sub">waiting on your response</div></div>' +
          '<div class="dash-stat"><div class="lbl">Submitted this month</div><div class="val" id="subDashStatSubmitted">\u2014</div><div class="sub" id="subDashStatSubmittedSub"></div></div>' +
          '<div class="dash-stat"><div class="lbl">Approved this month</div><div class="val" id="subDashStatApproved">\u2014</div><div class="sub" id="subDashStatApprovedSub"></div></div>' +
        '</div>' +
        '<div class="dash-grid">' +
        '<div class="dash-card">' +
        '<div class="dash-card-title">Cash in hand vs advances given</div>' +
        '<div id="subDashCashPieWrap"></div>' +
        '<div class="dash-note" id="subDashCashPieNote"></div>' +
        '</div>' +
        '<div class="dash-card">' +
        '<div class="dash-card-title">Advances given &mdash; who holds them</div>' +
        '<div id="subDashAdvPieWrap"></div>' +
        '<div class="dash-note" id="subDashAdvPieNote"></div>' +
        '</div>' +
        '</div>' +
        '<div class="dash-grid">' +
        '<div class="dash-card">' +
        '<div class="dash-card-title-row"><div class="dash-card-title" id="subDashAttentionTitle">Needs your attention</div><button class="btn btn-outline btn-sm" id="subDashAttentionGoBtn" style="width:auto;white-space:nowrap;">Open My Vouchers</button></div>' +
        '<div id="subDashAttentionWrap"></div>' +
        '</div>' +
        '<div class="dash-card">' +
        '<div class="dash-card-title">My vouchers by stage</div>' +
        '<div id="subDashStagesWrap"></div>' +
        '<div class="dash-note">Open queries are counted in addition to the stage a voucher is sitting at.</div>' +
        '</div>' +
        '</div>' +
        '<div class="dash-grid">' +
        '<div class="dash-card">' +
        '<div class="dash-card-title-row"><div class="dash-card-title">Advances open the longest</div><button class="btn btn-outline btn-sm" id="subDashAdvGoBtn" style="width:auto;white-space:nowrap;">Cash Advances</button></div>' +
        '<div id="subDashOldestWrap"></div>' +
        '</div>' +
        '<div class="dash-card">' +
        '<div class="dash-card-title">Advances given vs vouchers filed &mdash; last 7 days</div>' +
        '<div id="subDashDailyWrap"></div>' +
        '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>' +

  // RECENT SUBMISSIONS PAGE -- the submission role's own most recent vouchers,
  // moved out of the dashboard into its own sidebar page.
  '<div id="subRecentPage" class="page">' +
  '<div class="app-container">' +
  '<div class="page-head"><div><h1>Recent Submissions</h1><div class="sub">The vouchers you keyed in most recently, newest first</div></div><div class="page-head-actions"><button class="btn btn-outline btn-sm" id="subRecentRefreshBtn" style="width:auto;white-space:nowrap;">&#x21BB; Refresh</button></div></div>' +
  '<div class="app-body flat">' +
  '<div id="subRecentAlert" class="alert"></div>' +
  '<div class="dash-card">' +
  '<table class="voucher-table" id="subDashRecentTable"><thead><tr><th>Voucher ID</th><th>Date</th><th>Expense Type</th><th>Amount</th><th>Status</th></tr></thead><tbody id="subDashRecentBody"></tbody></table>' +
  '<div id="subDashRecentEmpty" class="empty-state hidden" style="padding:20px;"><p>No submissions yet.</p></div>' +
  '</div>' +
  '<div class="dash-note">Shows up to 25 vouchers. For everyone on your team, plus filters and edits, use My Vouchers.</div>' +
  '</div>' +
  '</div>' +
  '</div>' +

  // CASH ADVANCES PAGE FOR THE SUBMISSION ROLE -- record a new advance plus Open
  // Balances, Daily Log and Ledger. These four cards used to sit in a tab on the
  // dashboard; every element id inside them is unchanged, only the page moved.
  // (L1/accounts/L2/auditor have their own read-only Cash Advances page below.)
  '<div id="subCashAdvancesPage" class="page">' +
  '<div class="app-container">' +
  '<div class="page-head"><div><h1>Cash Advances</h1><div class="sub">Record advances, and track open balances, the daily log and each person&#39;s ledger</div></div></div>' +
  '<div class="app-body flat">' +
  '<div id="subCashAdvancesAlert" class="alert"></div>' +
        '<div class="dash-card">' +
          '<div class="dash-card-title">Cash Advances \u2014 Record New</div>' +
          '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">' +
            '<div class="form-group" style="margin:0;min-width:220px;"><label>Given To</label><select id="cashAdvanceGivenTo"><option value="">-- Select employee --</option></select></div>' +
            '<div class="form-group" style="margin:0;width:150px;"><label>Amount (Rs.)</label><input type="number" id="cashAdvanceAmount" min="0" step="0.01"></div>' +
            '<div class="form-group" style="margin:0;flex:1;min-width:180px;"><label>Purpose</label><input type="text" id="cashAdvancePurpose" placeholder="What is this for?"></div>' +
            '<button class="btn btn-primary btn-sm" id="cashAdvanceAddBtn" style="width:auto;">Record Advance</button>' +
          '</div>' +
          '<div id="cashAdvanceAlert" class="alert" style="margin-top:10px;margin-bottom:0;"></div>' +
        '</div>' +
        '<div class="dash-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
            '<div class="dash-card-title" style="margin:0;">Cash Advances \u2014 Open Balances</div>' +
            '<div style="display:flex;gap:8px;align-items:center;">' +
              '<button class="btn btn-outline btn-sm" id="subDashAdvancesRefreshBtn" style="width:auto;">&#x21BB; Refresh</button>' +
              '<button class="collapse-btn" title="Collapse" onclick="toggleDashCardCollapse(\'subDashAdvancesBalancesWrap\',this)">&#x25BE;</button>' +
            '</div>' +
          '</div>' +
          '<div id="subDashAdvancesBalancesWrap">' +
            '<div class="ca-filter-row">' +
              '<label>Since <select class="period-select" id="subDashAdvancesBalancesPeriod"><option value="0">Any time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select></label>' +
              '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="subDashAdvancesBalancesFlaggedOnly"> Flagged only</label>' +
            '</div>' +
            '<table class="voucher-table" id="subDashAdvancesBalancesTable"><thead><tr><th>Given To</th><th>Given</th><th>Submitted</th><th>Balance</th><th>Since</th><th>Days</th><th></th></tr></thead><tbody id="subDashAdvancesBalancesBody"></tbody></table>' +
            '<div id="subDashAdvancesBalancesEmpty" class="empty-state hidden" style="padding:16px;"><p>No open advances.</p></div>' +
          '</div>' +
        '</div>' +
        '<div class="dash-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:10px;">' +
            '<div class="dash-card-title" style="margin:0;">Cash Advances \u2014 Daily Log</div>' +
            '<div style="display:flex;align-items:center;gap:10px;">' +
              '<select class="period-select" id="subDashCaDailyLogPeriod"><option value="7">Last 7 days</option><option value="14" selected>Last 14 days</option><option value="30">Last 30 days</option><option value="60">Last 60 days</option><option value="90">Last 90 days</option></select>' +
              '<div class="filters" id="subDashCaDailyLogTabs">' +
                '<button class="filter-btn active" data-ca-daily-view="recon">Reconciliation</button>' +
                '<button class="filter-btn" data-ca-daily-view="breakdown">Breakdown</button>' +
              '</div>' +
              '<button class="btn btn-outline btn-sm" id="subDashCaDailyLogRefreshBtn" style="width:auto;">&#x21BB; Refresh</button>' +
              '<button class="collapse-btn" title="Collapse" onclick="toggleDashCardCollapse(\'subDashCaDailyLogWrap\',this)">&#x25BE;</button>' +
            '</div>' +
          '</div>' +
          '<div id="subDashCaDailyLogWrap">' +
            '<div id="subDashCaDailyLogRecon">' +
              '<table class="voucher-table" id="subDashCaDailyLogTable"><thead><tr><th>Date</th><th>Advance Given</th><th>Vouchers Filed</th><th></th></tr></thead><tbody id="subDashCaDailyLogBody"></tbody></table>' +
            '</div>' +
            '<div id="subDashCaDailyLogBreakdown" class="hidden"></div>' +
            '<div id="subDashCaDailyLogEmpty" class="empty-state hidden" style="padding:20px;"><p>No advances or vouchers in this window.</p></div>' +
          '</div>' +
        '</div>' +
        '<div class="dash-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
            '<div class="dash-card-title" style="margin:0;">Cash Advances \u2014 Ledger</div>' +
            '<button class="collapse-btn" title="Collapse" onclick="toggleDashCardCollapse(\'subDashAdvancesLedgerWrap\',this)">&#x25BE;</button>' +
          '</div>' +
          '<div id="subDashAdvancesLedgerWrap">' +
            '<div class="ca-filter-row">' +
              '<div class="form-group" style="margin:0;max-width:280px;flex:1;"><label>Person</label><select id="subDashAdvancesLedgerPerson"><option value="">-- Select --</option></select></div>' +
              '<div class="form-group" style="margin:0;"><label>From</label><input type="date" id="subDashAdvancesLedgerDateFrom" style="padding:8px 10px;border:1px solid #D9DDF0;border-radius:8px;font-size:13px;font-family:inherit;"></div>' +
              '<div class="form-group" style="margin:0;"><label>To</label><input type="date" id="subDashAdvancesLedgerDateTo" style="padding:8px 10px;border:1px solid #D9DDF0;border-radius:8px;font-size:13px;font-family:inherit;"></div>' +
            '</div>' +
            '<div id="subDashAdvancesLedgerHeader" class="ca-ledger-header hidden"></div>' +
            '<table class="voucher-table hidden" id="subDashAdvancesLedgerTable"><thead><tr><th>Date</th><th>Type</th><th>Ref</th><th>Description</th><th>Advance (Dr)</th><th>Voucher (Cr)</th><th>Balance</th></tr></thead><tbody id="subDashAdvancesLedgerBody"></tbody></table>' +
            '<div id="subDashAdvancesLedgerEmpty" class="empty-state hidden" style="padding:16px;"><p>No entries for this person.</p></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>' +

  // CASH ADVANCES PAGE (per explicit instruction) — shared view for L1/
  // accounts/L2 via the nav-strip (admin reaches the same data through
  // its own admin tab instead, matching how Admin never uses this strip
  // elsewhere). Balances table always visible; the ledger view below it
  // only renders once a person is picked. Accounts additionally records
  // new advances from the Approval Dashboard panel, not here — this page
  // is deliberately read-only everywhere so the two never duplicate the
  // same form.
  '<div id="cashAdvancesPage" class="page">' +
    '<div class="app-container">' +
      '<div class="page-head"><div><h1>Cash Advances</h1><div class="sub">Open balances, daily log and ledger per person</div></div></div>' +
      '<div class="app-body flat">' +
        '<div id="cashAdvancesAlert" class="alert"></div>' +
        '<div class="dash-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
            '<div class="dash-card-title" style="margin:0;">Open Balances</div>' +
            '<div style="display:flex;gap:8px;align-items:center;">' +
              '<button class="btn btn-outline btn-sm" id="cashAdvancesRefreshBtn" style="width:auto;">&#x21BB; Refresh</button>' +
              '<button class="collapse-btn" title="Collapse" onclick="toggleDashCardCollapse(\'cashAdvancesBalancesWrap\',this)">&#x25BE;</button>' +
            '</div>' +
          '</div>' +
          '<div id="cashAdvancesBalancesWrap">' +
            '<div class="ca-filter-row">' +
              '<label>Since <select class="period-select" id="cashAdvancesBalancesPeriod"><option value="0">Any time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select></label>' +
              '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="cashAdvancesBalancesFlaggedOnly"> Flagged only</label>' +
            '</div>' +
            '<table class="voucher-table" id="cashAdvancesBalancesTable"><thead><tr><th>Given To</th><th>Given</th><th>Submitted</th><th>Balance</th><th>Since</th><th>Days</th><th></th></tr></thead><tbody id="cashAdvancesBalancesBody"></tbody></table>' +
            '<div id="cashAdvancesBalancesEmpty" class="empty-state hidden" style="padding:20px;"><p>No open advances.</p></div>' +
          '</div>' +
        '</div>' +
        '<div class="dash-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:10px;">' +
            '<div class="dash-card-title" style="margin:0;">Daily Log</div>' +
            '<div style="display:flex;align-items:center;gap:10px;">' +
              '<select class="period-select" id="caDailyLogPeriod"><option value="7">Last 7 days</option><option value="14" selected>Last 14 days</option><option value="30">Last 30 days</option><option value="60">Last 60 days</option><option value="90">Last 90 days</option></select>' +
              '<div class="filters" id="caDailyLogTabs">' +
                '<button class="filter-btn active" data-ca-daily-view="recon">Reconciliation</button>' +
                '<button class="filter-btn" data-ca-daily-view="breakdown">Breakdown</button>' +
              '</div>' +
              '<button class="btn btn-outline btn-sm" id="caDailyLogRefreshBtn" style="width:auto;">&#x21BB; Refresh</button>' +
              '<button class="collapse-btn" title="Collapse" onclick="toggleDashCardCollapse(\'caDailyLogWrap\',this)">&#x25BE;</button>' +
            '</div>' +
          '</div>' +
          '<div id="caDailyLogWrap">' +
            '<div id="caDailyLogRecon">' +
              '<table class="voucher-table" id="caDailyLogTable"><thead><tr><th>Date</th><th>Advance Given</th><th>Vouchers Filed</th><th></th></tr></thead><tbody id="caDailyLogBody"></tbody></table>' +
            '</div>' +
            '<div id="caDailyLogBreakdown" class="hidden"></div>' +
            '<div id="caDailyLogEmpty" class="empty-state hidden" style="padding:20px;"><p>No advances or vouchers in this window.</p></div>' +
          '</div>' +
        '</div>' +
        '<div class="dash-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
            '<div class="dash-card-title" style="margin:0;">Ledger</div>' +
            '<button class="collapse-btn" title="Collapse" onclick="toggleDashCardCollapse(\'cashAdvancesLedgerWrap\',this)">&#x25BE;</button>' +
          '</div>' +
          '<div id="cashAdvancesLedgerWrap">' +
            '<div class="ca-filter-row">' +
              '<div class="form-group" style="margin:0;max-width:280px;flex:1;"><label>Person</label><select id="cashAdvancesLedgerPerson"><option value="">-- Select --</option></select></div>' +
              '<div class="form-group" style="margin:0;"><label>From</label><input type="date" id="cashAdvancesLedgerDateFrom" style="padding:8px 10px;border:1px solid #D9DDF0;border-radius:8px;font-size:13px;font-family:inherit;"></div>' +
              '<div class="form-group" style="margin:0;"><label>To</label><input type="date" id="cashAdvancesLedgerDateTo" style="padding:8px 10px;border:1px solid #D9DDF0;border-radius:8px;font-size:13px;font-family:inherit;"></div>' +
            '</div>' +
            '<div id="cashAdvancesLedgerHeader" class="ca-ledger-header hidden"></div>' +
            '<table class="voucher-table hidden" id="cashAdvancesLedgerTable"><thead><tr><th>Date</th><th>Type</th><th>Ref</th><th>Description</th><th>Advance (Dr)</th><th>Voucher (Cr)</th><th>Balance</th></tr></thead><tbody id="cashAdvancesLedgerBody"></tbody></table>' +
            '<div id="cashAdvancesLedgerEmpty" class="empty-state hidden" style="padding:16px;"><p>No entries for this person.</p></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>' +

  // LANDING DASHBOARD (#18, design pass) — default post-login landing for
  // L1/accounts/L2/admin (see routeToRolePage). One data source
  // (getDashboardSummary) feeds every widget on this page, so nothing can
  // show numbers that disagree with each other.
  // Migrated to the sidebar shell (design pass, sidebar redesign): the
  // old app-header's title/user-badge/Change Password/Log Out are gone
  // \u2014 identity and those two actions now live once, in the sidebar
  // footer (see #sbName/#sbRole/#sbChangePwBtn/#sbLogoutBtn). Only the
  // page title + role-specific subtitle remain here, as a slim page-head.
  '<div id="dashboardPage" class="page">' +
    '<div class="page-head"><div><h1>Dashboard</h1><div class="sub" id="dashboardSubtitle">Overview</div></div></div>' +
    '<div id="dashboardAlert" class="alert"></div>' +
    '<div class="dash-stats">' +
      '<div class="dash-stat"><div class="lbl">Ready to release</div><div class="val" id="dashStatReady">\u2014</div><div class="sub" id="dashStatReadySub"></div></div>' +
      '<div class="dash-stat"><div class="lbl">Pending approval</div><div class="val" id="dashStatPending">\u2014</div><div class="sub">across L1, Accounts, L2</div></div>' +
      '<div class="dash-stat"><div class="lbl">Open queries</div><div class="val" id="dashStatQueries">\u2014</div><div class="sub">waiting on submitters</div></div>' +
      '<div class="dash-stat"><div class="lbl">This month, approved</div><div class="val" id="dashStatMonth">\u2014</div><div class="sub" id="dashStatMonthSub"></div></div>' +
    '</div>' +
    '<div class="dash-grid">' +
      '<div class="dash-card">' +
        '<div class="dash-card-title">Top vendors</div>' +
        '<table class="voucher-table" id="dashVendorsTable"><tbody id="dashVendorsBody"></tbody></table>' +
        '<div id="dashVendorsEmpty" class="empty-state hidden" style="padding:20px;"><p>No vendor data yet.</p></div>' +
      '</div>' +
      '<div class="dash-card">' +
        '<div class="dash-card-title-row">' +
          '<div class="dash-card-title">Expense type split</div>' +
          '<select id="dashBatchSelect" style="width:auto;height:32px;padding:2px 8px;font-size:13.5px;"></select>' +
        '</div>' +
        '<div id="dashPieWrap"><div id="dashPieEmpty" class="empty-state" style="padding:20px;"><p>No data for this batch.</p></div></div>' +
      '</div>' +
    '</div>' +
  '</div>' +

  // APPROVAL PAGE
  '<div id="approvalPage" class="page">' +
    '<div class="app-container">' +
      '<div class="page-head"><div><h1>Approval Queue</h1><div class="sub" id="approvalRoleLabel">Approval Dashboard</div></div></div>' +
      '<div class="app-body flat">' +
        '<div id="approvalAlert" class="alert"></div>' +
        '<div id="rdsCashGivenPanel" class="filter-bar hidden">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">' +
            '<div>' +
              '<div style="font-weight:700;color:#14173F;font-size:14px;">Cash Given to Warehouse</div>' +
              '<div id="rdsCashGivenStatusText" style="font-size:14.5px;color:#454B6B;margin-top:4px;">Loading...</div>' +
            '</div>' +
            '<button class="btn btn-outline btn-sm" id="rdsCashGivenRefreshBtn" style="width:auto;">&#x21BB; Refresh</button>' +
          '</div>' +
          // Batch/voucher selection (24 Aug 2026 fix) — release now only
          // covers what's checked here, never the whole backlog silently.
          // Each batch is its own checkbox (select every voucher in that
          // batch at once) with an expandable list of individual vouchers
          // underneath for a single-voucher release within a batch.
          // Anything left unchecked stays "Ready to Release".
          '<div id="rdsCashGivenBatches" style="margin-top:12px;max-height:280px;overflow-y:auto;border:1px solid #ECEEFB;border-radius:8px;"></div>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;flex-wrap:wrap;gap:12px;">' +
            '<div id="rdsCashGivenSelectedText" style="font-size:14.5px;color:#454B6B;">Select at least one batch or voucher.</div>' +
            '<div style="display:flex;gap:8px;align-items:center;">' +
              '<input type="number" id="rdsCashGivenAmount" min="0" step="0.01" placeholder="Amount actually given (Rs.)" style="width:210px;padding:9px 12px;border:1px solid #D9DDF0;border-radius:8px;font-size:14px;font-family:inherit;">' +
              '<button class="btn btn-primary btn-sm" id="rdsCashGivenAddBtn" disabled>Add Cash Given</button>' +
            '</div>' +
          '</div>' +
          '<div id="rdsCashGivenAlert" class="alert" style="margin-top:10px;margin-bottom:0;"></div>' +
          '<div id="rdsCashGivenLog" style="margin-top:8px;font-size:13.5px;color:#454B6B;"></div>' +
        '</div>' +
        '<div id="cashWithdrawalPanel" class="filter-bar hidden">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">' +
            '<div>' +
              '<div style="font-weight:700;color:#14173F;font-size:14px;">Cash Withdrawal Approval (Bank Replenishment)</div>' +
              '<div id="cashWithdrawalStatusText" style="font-size:14.5px;color:#454B6B;margin-top:4px;">Loading...</div>' +
            '</div>' +
            '<button class="btn btn-outline btn-sm" id="cashWithdrawalRefreshBtn" style="width:auto;">&#x21BB; Refresh</button>' +
          '</div>' +
          // Batch-level only (no per-voucher drill-down, unlike Cash Given
          // above) — a withdrawal request is always a whole fully-approved
          // batch or nothing, per explicit instruction ("accounts will
          // select batches"), so there's no single-voucher case to expose.
          '<div id="cashWithdrawalBatches" style="margin-top:12px;max-height:220px;overflow-y:auto;border:1px solid #ECEEFB;border-radius:8px;"></div>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;flex-wrap:wrap;gap:12px;">' +
            '<div id="cashWithdrawalSelectedText" style="font-size:14.5px;color:#454B6B;">Select at least one fully-approved batch.</div>' +
            '<button class="btn btn-primary btn-sm" id="cashWithdrawalRequestBtn" disabled>Email L2 for Approval</button>' +
          '</div>' +
          '<div id="cashWithdrawalAlert" class="alert" style="margin-top:10px;margin-bottom:0;"></div>' +
          '<div style="margin-top:14px;">' +
            '<div style="font-weight:600;color:#14173F;font-size:13.5px;margin-bottom:6px;">Recent Withdrawal Requests</div>' +
            '<div id="cashWithdrawalHistory" style="font-size:13.5px;color:#454B6B;"></div>' +
          '</div>' +
        '</div>' +
        // L2's own withdrawal-approval panel (16 Sep 2026, per explicit
        // instruction). Same slot on the same approval page that Accounts
        // sees cashWithdrawalPanel in, but a separate element rather than a
        // role-branching rewrite of that one: the two panels do opposite
        // jobs (raise a request vs decide one) and share no controls, so
        // folding them together would mean a conditional in every handler
        // for no reuse. Shown only for role L2 (loadApprovalDashboard),
        // and the server re-checks the role on every call regardless.
        '<div id="l2WithdrawalPanel" class="filter-bar hidden">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">' +
            '<div>' +
              '<div style="font-weight:700;color:#14173F;font-size:14px;">Cash Withdrawal Approval (Bank Replenishment)</div>' +
              '<div id="l2WithdrawalStatusText" style="font-size:14.5px;color:#454B6B;margin-top:4px;">Loading...</div>' +
            '</div>' +
            '<button class="btn btn-outline btn-sm" id="l2WithdrawalRefreshBtn" style="width:auto;">&#x21BB; Refresh</button>' +
          '</div>' +
          '<div id="l2WithdrawalAlert" class="alert" style="margin-top:10px;margin-bottom:0;"></div>' +
          '<div id="l2WithdrawalList" style="margin-top:12px;"></div>' +
          '<div style="margin-top:14px;">' +
            '<div style="font-weight:600;color:#14173F;font-size:13.5px;margin-bottom:6px;">Recently Decided</div>' +
            '<div id="l2WithdrawalHistory" style="font-size:13.5px;color:#454B6B;"></div>' +
          '</div>' +
        '</div>' +
        filterBarHtml('appr') +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
          '<div class="filters" id="filterBtns">' +
            '<button class="filter-btn" data-filter="all">All</button>' +
            '<button class="filter-btn" data-filter="Pending L1">Pending L1</button>' +
            '<button class="filter-btn" data-filter="Pending Accounts">Pending Accounts</button>' +
            '<button class="filter-btn" data-filter="Pending L2">Pending L2</button>' +
            '<button class="filter-btn" data-filter="Approved">Approved</button>' +
            '<button class="filter-btn" data-filter="Rejected">Rejected</button>' +
            '<button class="filter-btn" data-filter="Query">Query</button>' +
          '</div>' +
          '<button class="btn btn-outline btn-sm" id="refreshBtn" style="white-space:nowrap;">&#x21BB; Refresh</button>' +
        '</div>' +
        '<table class="voucher-table" id="vouchersTable">' +
          '<thead><tr><th>Progress</th><th>Status</th><th>Voucher ID</th><th>Date</th><th>Submitted By</th><th>Expense Type</th><th>Amount</th><th>Cost Centre</th><th>Actions</th></tr></thead>' +
          '<tbody id="vouchersBody"></tbody>' +
        '</table>' +
        '<div id="emptyState" class="empty-state hidden"><div class="icon">&#x1F4EB;</div><div class="title" id="emptyStateTitle">No vouchers found</div><div class="sub hidden" id="emptyStateSub"></div><span class="chip-clear hidden" id="emptyStateClearBtn">&#x2715; Clear filter and show all</span></div>' +
      '</div>' +
    '</div>' +
  '</div>' +

  // ADMIN PAGE — split into three toggle tabs (Vendor Addition / Role
  // Unlock / Voucher Monitoring) instead of one long scroll, same idea as
  // the separate Tally Export page.
  '<div id="adminPage" class="page">' +
    '<div class="app-container">' +
      '<div class="page-head"><div><h1>Admin</h1><div class="sub">Manage vendors, users, cash and voucher monitoring</div></div></div>' +
      '<div class="app-body flat">' +
        '<div id="adminAlert" class="alert"></div>' +
        '<div class="filters" id="adminTabBtns">' +
          '<button class="admin-nav-tab" data-admin-tab="vendor">Vendor Addition</button>' +
          '<button class="admin-nav-tab" data-admin-tab="users">Manage Users</button>' +
          '<button class="admin-nav-tab" data-admin-tab="vouchers">Voucher Monitoring</button>' +
          '<button class="admin-nav-tab" data-admin-tab="cashgiven">Cash Given (Today)</button>' +
          '<button class="admin-nav-tab" data-admin-tab="cashadvances">Cash Advances</button>' +
          '<button class="admin-nav-tab" data-admin-tab="cashwithdrawals">Cash Withdrawals</button>' +
        '</div>' +

        // --- Vendor Addition tab ---
        '<div id="adminTabVendor" class="admin-tab-content">' +
          '<div class="section-title" style="border:none;margin:0 0 16px;padding:0;">Add Vendor</div>' +
          '<div class="grid-2">' +
            '<div class="form-group"><label>Vendor Name <span class="req">*</span></label><input type="text" id="newVendorName" placeholder="e.g., Arco Transport Co."><div id="newVendorDupWarning" class="vendor-check-inline hidden"></div></div>' +
            '<div class="form-group"><label>TDS Rate (194C)</label>' +
              '<select id="newVendorTdsRate"><option value="">Not Applicable</option><option value="1">1% (Individual / HUF)</option><option value="2">2% (Others)</option></select>' +
            '</div>' +
          '</div>' +
          '<div class="grid-2">' +
            '<div class="form-group"><label>PAN</label><input type="text" id="newVendorPan" placeholder="e.g., ABCDE1234F" maxlength="10" style="text-transform:uppercase;"></div>' +
            '<div class="form-group" style="display:flex;align-items:flex-end;padding-bottom:10px;">' +
              '<label style="display:flex;align-items:center;gap:8px;font-weight:400;cursor:pointer;">' +
                '<input type="checkbox" id="newVendorDeclaration"> 194C declaration on file (&lt;11 trucks) \u2014 TDS Not Applicable' +
              '</label>' +
            '</div>' +
          '</div>' +
          '<div class="grid-2">' +
            '<div class="form-group"><label>Starting Ledger Balance (Rs.)</label>' +
              '<input type="number" id="newVendorLedgerBalance" min="0" step="0.01" placeholder="0.00">' +
              '<div style="font-size:13.5px;color:#454B6B;margin-top:4px;">One-time setup only \u2014 total already billed to this vendor before today, if any. Every submission after this adds to it automatically.</div>' +
            '</div>' +
          '</div>' +
          '<div class="btn-row"><button class="btn btn-primary" id="adminAddVendorBtn" style="width:auto;">Add Vendor</button></div>' +
          '<div style="height:28px;"></div>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<button class="btn btn-outline btn-sm" id="vendorListToggleBtn">&#x25B2; Hide Registered Vendors</button>' +
            '<button class="btn btn-outline btn-sm" id="adminRefreshBtn">&#x21BB; Refresh</button>' +
          '</div>' +
          '<div id="vendorListWrap" style="margin-top:16px;">' +
            '<table class="voucher-table" id="vendorsTable">' +
              '<thead><tr><th>Vendor Name</th><th>TDS Applicable</th><th>TDS Rate</th><th>PAN</th><th>194C Declaration</th><th>Ledger Balance</th><th>Actions</th></tr></thead>' +
              '<tbody id="vendorsBody"></tbody>' +
            '</table>' +
            '<div id="adminEmptyState" class="empty-state hidden"><div class="icon">&#x1F4CB;</div><p>No vendors found</p></div>' +
          '</div>' +
        '</div>' +

        // --- Manage Users tab (Day 5) — admin creates/deactivates/
        // resets individual logins for the 4 multi-user roles (submission,
        // L1, accounts, L2). 'admin' itself isn't managed here — it stays
        // the single shared PIN, changed via the ADMIN_PIN Script
        // Property, not through this UI.
        '<div id="adminTabUsers" class="admin-tab-content hidden">' +
          // Scheduled reminders repair (per explicit instruction) — surfaces
          // and fixes the "one-time manual Apps Script setup was silently
          // never run" failure mode for every trigger-driven email in this
          // system, right next to where their recipients (Email column) are
          // configured, since a broken trigger and a missing Email look
          // identical from the outside: no email ever arrives.
          '<div class="dash-card" style="margin-bottom:20px;">' +
            '<div class="dash-card-title">Scheduled Reminders</div>' +
            '<p style="color:#454B6B;font-size:14.5px;margin:0 0 12px;">Query aging digest, same-day query alert, approver daily digest, and RDS day-open all run on daily triggers that need a one-time install. If reminder emails have stopped arriving, use this to reinstall all four \u2014 safe to run any time.</p>' +
            '<button class="btn btn-outline btn-sm" id="adminRepairTriggersBtn" style="width:auto;">Reinstall Scheduled Reminders</button>' +
            '<div id="adminRepairTriggersAlert" class="alert" style="margin-top:10px;margin-bottom:0;"></div>' +
          '</div>' +
          // Session overrides: fallbacks for when session tracking misbehaves (see Auth.gs).
          '<div class="dash-card" style="margin-bottom:20px;">' +
          '<div class="dash-card-title">Sessions (override tools)</div>' +
          '<p style="color:#454B6B;font-size:14.5px;margin:0 0 12px;">Each account can be logged in once at a time. If someone is stuck, use <b>End session</b> on their row below: it logs them out everywhere, even if the app cannot see their session. These two are the wider fallbacks.</p>' +
          '<div class="action-btns"><button class="btn btn-outline btn-sm" id="adminEndAllSessionsBtn" style="width:auto;">End all user sessions</button><button class="btn btn-outline btn-sm" id="adminToggleSessionRuleBtn" data-enforced="true" style="width:auto;">Pause the one-login rule</button></div>' +
          '<div id="sessionRuleStatus" class="dash-note" role="status"></div>' +
          '</div>' +
          '<div class="section-title" style="border:none;margin:0 0 16px;padding:0;">Add User</div>' +
          '<div class="grid-2">' +
            '<div class="form-group"><label>Display Name <span class="req">*</span></label><input type="text" id="newUserDisplayName" placeholder="e.g., Priya Sharma"></div>' +
            '<div class="form-group"><label>Position in company <span style="color:var(--text-muted,#5F6684);font-weight:400;">(shown instead of the app role)</span></label><input type="text" id="newUserDesignation" list="positionOptions" maxlength="80" placeholder="e.g., Warehouse Manager" autocomplete="off"><datalist id="positionOptions"></datalist></div>' +
          '</div>' +
          '<div class="grid-2">' +
            '<div class="form-group"><label>App access (role) <span class="req">*</span></label>' +
              '<select id="newUserRole"><option value="">-- Select role --</option><option value="submission">Submission</option><option value="L1">L1</option><option value="accounts">Accounts</option><option value="L2">L2</option><option value="auditor">Auditor</option></select>' +
            '</div>' +
            '<div class="form-group"><label>Username <span class="req">*</span></label><input type="text" id="newUserUsername" placeholder="e.g., priya.s" autocomplete="off"></div>' +
          '</div>' +
          '<div class="grid-2">' +
            '<div class="form-group"><label>Password <span class="req">*</span></label>' +
              '<div style="position:relative;">' +
                '<input type="password" id="newUserPassword" placeholder="Min. 8 characters, 1 letter + 1 number" autocomplete="new-password" style="width:100%;padding-right:40px;box-sizing:border-box;">' +
                pwEyeToggleHtml('newUserPassword') +
              '</div></div>' +
            '<div class="form-group"><label>Email <span style="color:var(--text-muted,#5F6684);font-weight:400;">(optional \u2014 for query reminders)</span></label><input type="email" id="newUserEmail" placeholder="name@example.com" autocomplete="off"></div>' +
          '</div>' +
          '<div class="btn-row"><button class="btn btn-primary" id="adminAddUserBtn" style="width:auto;">Add User</button></div>' +
          '<div style="height:20px;"></div>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
            '<div class="section-title" style="border:none;margin:0;padding:0;">Existing Users</div>' +
            '<button class="btn btn-outline btn-sm" id="adminUsersRefreshBtn">&#x21BB; Refresh</button>' +
          '</div>' +
          '<table class="voucher-table" id="usersTable">' +
            '<thead><tr><th>Display Name</th><th>Username</th><th>Position</th><th>Email</th><th>Status</th><th>Last Login</th><th>Actions</th></tr></thead>' +
            '<tbody id="usersBody"></tbody>' +
          '</table>' +
          '<div id="usersEmptyState" class="empty-state hidden"><div class="icon">&#x1F464;</div><p>No users yet \\u2014 add one above.</p></div>' +
        '</div>' +

        // --- Voucher Monitoring tab ---
        '<div id="adminTabVouchers" class="admin-tab-content hidden">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
            '<div class="section-title" style="border:none;margin:0;padding:0;">Vouchers \u2014 Revert / Override</div>' +
          '</div>' +
          filterBarHtml('admin') +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
            '<div class="filters" id="adminVoucherStatusBtns">' +
              '<button class="filter-btn active" data-admin-status="all">All</button>' +
              '<button class="filter-btn" data-admin-status="Pending L1">Pending L1</button>' +
              '<button class="filter-btn" data-admin-status="Pending Accounts">Pending Accounts</button>' +
              '<button class="filter-btn" data-admin-status="Pending L2">Pending L2</button>' +
              '<button class="filter-btn" data-admin-status="Approved">Approved</button>' +
              '<button class="filter-btn" data-admin-status="Rejected">Rejected</button>' +
              '<button class="filter-btn" data-admin-status="Query">Query</button>' +
            '</div>' +
            '<button class="btn btn-outline btn-sm" id="adminVouchersRefreshBtn" style="white-space:nowrap;">&#x21BB; Refresh</button>' +
          '</div>' +
          '<table class="voucher-table" id="adminVouchersTable">' +
            '<thead><tr><th>Status</th><th>Voucher ID</th><th>Date</th><th>Submitted By</th><th>Amount</th><th>Query</th><th>Action</th></tr></thead>' +
            '<tbody id="adminVouchersBody"></tbody>' +
          '</table>' +
          '<div id="adminVouchersEmptyState" class="empty-state hidden"><div class="icon">&#x1F4EB;</div><div class="title" id="adminVouchersEmptyTitle">No vouchers found</div><div class="sub hidden" id="adminVouchersEmptySub"></div><span class="chip-clear hidden" id="adminVouchersEmptyClearBtn">&#x2715; Clear filter and show all</span></div>' +
        '</div>' +

        // --- Cash Given tab — admin correction of a mistaken "Cash Given
        // by Accounts" RDS entry. CHANGED: release now spans the whole
        // unreleased backlog rather than "today's batch", so entries are
        // no longer scoped to today only — shows current + previous
        // month tab (see listRecentRdsCashGivenEntries, Sheet Utils.gs).
        // Removing an entry reverts every voucher it released back to
        // unreleased server-side (unmarkVouchersCashReleasedByRdsVoucherNo).
        '<div id="adminTabCashgiven" class="admin-tab-content hidden">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
            '<div class="section-title" style="border:none;margin:0;padding:0;">Cash Given by Accounts</div>' +
            '<button class="btn btn-outline btn-sm" id="adminCashGivenRefreshBtn">&#x21BB; Refresh</button>' +
          '</div>' +
          '<p style="color:#454B6B;font-size:14.5px;margin:0 0 16px;">Correct or remove a Cash Given entry. Removing one reverts every voucher it released back to unreleased \u2014 Accounts will see them again in the running total next time.</p>' +
          '<div id="adminCashGivenAlert" class="alert"></div>' +
          '<table class="voucher-table" id="adminCashGivenTable">' +
            '<thead><tr><th>Date</th><th>Entry ID</th><th>Amount</th><th>Action</th></tr></thead>' +
            '<tbody id="adminCashGivenBody"></tbody>' +
          '</table>' +
          '<div id="adminCashGivenEmptyState" class="empty-state hidden"><div class="icon">&#x1F4B8;</div><p>No Cash Given entries found</p></div>' +
        '</div>' +

        // --- Cash Advances tab (per explicit instruction) — a standalone
        // Rabale Expense System ledger, entirely separate from RDS's own
        // (manual, periodic-reconciliation) Advance column; see the CA
        // object's comment in Config.gs. Correction table plus a ledger
        // viewer below it, since Admin doesn't use the nav-strip that
        // L1/accounts/L2 reach the same ledger view through.
        '<div id="adminTabCashadvances" class="admin-tab-content hidden">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
            '<div class="section-title" style="border:none;margin:0;padding:0;">Cash Advances</div>' +
            '<button class="btn btn-outline btn-sm" id="adminCashAdvancesRefreshBtn">&#x21BB; Refresh</button>' +
          '</div>' +
          '<p style="color:#454B6B;font-size:14.5px;margin:0 0 16px;">Correct or remove a Cash Advance entry.</p>' +
          '<div id="adminCashAdvancesAlert" class="alert"></div>' +
          '<table class="voucher-table" id="adminCashAdvancesTable">' +
            '<thead><tr><th>Date</th><th>Given To</th><th>Amount</th><th>Purpose</th><th>Given By</th><th>Action</th></tr></thead>' +
            '<tbody id="adminCashAdvancesBody"></tbody>' +
          '</table>' +
          '<div id="adminCashAdvancesEmptyState" class="empty-state hidden"><div class="icon">&#x2696;</div><p>No Cash Advance entries found</p></div>' +
          '<div class="form-group" style="max-width:320px;margin-top:20px;"><label>View ledger for</label><select id="adminCashAdvanceLedgerPerson"><option value="">-- Select --</option></select></div>' +
          '<div id="adminCashAdvanceLedgerHeader" class="ca-ledger-header hidden"></div>' +
          '<table class="voucher-table hidden" id="adminCashAdvanceLedgerTable"><thead><tr><th>Date</th><th>Type</th><th>Ref</th><th>Description</th><th>Advance (Dr)</th><th>Voucher (Cr)</th><th>Balance</th></tr></thead><tbody id="adminCashAdvanceLedgerBody"></tbody></table>' +
          '<div id="adminCashAdvanceLedgerEmpty" class="empty-state hidden" style="padding:16px;"><p>No entries for this person.</p></div>' +
        '</div>' +

        // --- Cash Withdrawals tab — admin records L2's email reply
        // (Approved/Rejected) against a Pending request. This is the
        // ONLY place that decision gets recorded; the actual approval
        // itself happens over email, outside the app, per explicit
        // instruction.
        '<div id="adminTabCashwithdrawals" class="admin-tab-content hidden">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
            '<div class="section-title" style="border:none;margin:0;padding:0;">Cash Withdrawal Requests</div>' +
            '<button class="btn btn-outline btn-sm" id="adminCashWithdrawalsRefreshBtn">&#x21BB; Refresh</button>' +
          '</div>' +
          '<p style="color:#454B6B;font-size:14.5px;margin:0 0 16px;">L2 now approves or rejects these in the app themselves \\u2014 use this tab only as a fallback, to record a reply that arrived by email when L2 cannot log in. Either way Accounts is emailed automatically (L2 in cc). Approved is permanent \\u2014 Accounts can then release cash against these vouchers. Rejected unlocks them for a corrected request.</p>' +
          '<div id="adminCashWithdrawalsAlert" class="alert"></div>' +
          '<table class="voucher-table" id="adminCashWithdrawalsTable">' +
            '<thead><tr><th>Withdrawal ID</th><th>Requested</th><th>Batch(es)</th><th>Period</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead>' +
            '<tbody id="adminCashWithdrawalsBody"></tbody>' +
          '</table>' +
          '<div id="adminCashWithdrawalsEmptyState" class="empty-state hidden"><div class="icon">&#x1F3E6;</div><p>No withdrawal requests found</p></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>' +

  // Admin Cash Advance edit modal — mirrors adminCashGivenEditModal.
  '<div id="adminCashAdvanceEditModal" class="modal-overlay">' +
    '<div class="modal-box"><div class="modal-title">Edit Advance Amount</div>' +
      '<div id="adminCashAdvanceEditAlert" class="alert"></div>' +
      '<div class="form-group"><label>New Amount (Rs.) <span class="req">*</span></label>' +
        '<input type="number" id="adminCashAdvanceEditAmount" min="0" step="0.01"></div>' +
      '<div class="modal-buttons"><button class="btn btn-outline" id="cancelCashAdvanceEditBtn">Cancel</button><button class="btn btn-primary" id="confirmCashAdvanceEditBtn">Save</button></div>' +
    '</div>' +
  '</div>' +

  // Admin Cash Given edit modal — simple amount-correction dialog,
  // matching the existing modal pattern used by Change ID / Change
  // Password elsewhere in this file.
  '<div id="adminCashGivenEditModal" class="modal-overlay">' +
    '<div class="modal-box"><div class="modal-title">Edit Cash Given Amount</div>' +
      '<div id="adminCashGivenEditAlert" class="alert"></div>' +
      '<div class="form-group"><label>New Amount (Rs.) <span class="req">*</span></label>' +
        '<input type="number" id="adminCashGivenEditAmount" min="0" step="0.01">' +
      '</div>' +
      '<div class="modal-buttons"><button class="btn btn-outline" id="cancelCashGivenEditBtn">Cancel</button><button class="btn btn-primary" id="confirmCashGivenEditBtn">Save</button></div>' +
    '</div>' +
  '</div>' +

  // TALLY EXPORT PAGE — reachable from Accounts' approval dashboard or Admin.
  // Shows Approved + not-yet-exported vouchers, filterable the same way as
  // every other voucher table, with per-row checkboxes so a single voucher,
  // a whole batch, or a numeric range can all be selected the same way.
  '<div id="tallyExportPage" class="page">' +
    '<div class="app-container">' +
      '<div class="page-head"><div><h1>Tally Export</h1><div class="sub">Select approved vouchers to export to Tally</div></div></div>' +
      '<div class="app-body flat">' +
        '<div id="tallyAlert" class="alert"></div>' +
        '<div class="filters" id="tallyModeBtns" style="margin-bottom:12px;">' +
          '<button class="filter-btn active" data-tally-mode="pending">Pending Export</button>' +
          '<button class="filter-btn" data-tally-mode="exported">Already Exported</button>' +
        '</div>' +
        '<p id="tallyModeHint" style="color:#454B6B;font-size:14px;margin-bottom:16px;">Showing <strong>Approved</strong> vouchers not yet exported to Tally. Select the ones to export \u2014 one voucher, a batch, or a range all work the same way.</p>' +
        filterBarHtml('tally') +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
          '<label id="tallySelectAllWrap" style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:14.5px;color:#454B6B;cursor:pointer;">' +
            '<input type="checkbox" id="tallySelectAll"> Select All Shown' +
          '</label>' +
          '<button class="btn btn-outline btn-sm" id="tallyRefreshBtn">&#x21BB; Refresh</button>' +
        '</div>' +
        '<table class="voucher-table" id="tallyVouchersTable">' +
          '<thead><tr id="tallyTableHeadRow"><th></th><th>Voucher ID</th><th>Date</th><th>Submitted By</th><th>Expense Type</th><th>Amount</th><th>Batch ID</th></tr></thead>' +
          '<tbody id="tallyVouchersBody"></tbody>' +
        '</table>' +
        '<div id="tallySelectionSummary" class="tally-sticky-bar">' +
          '<span class="tally-sticky-sum" id="tallySelectionSumText">0 vouchers selected</span>' +
          '<button class="btn btn-primary btn-sm" id="tallyGenerateBtn" style="width:auto;" disabled>Generate Tally Export for Selected</button>' +
        '</div>' +
        '<div id="tallyEmptyState" class="empty-state hidden"><div class="icon">&#x1F4EB;</div><div class="title" id="tallyEmptyTitle">No vouchers pending Tally export</div><div class="sub hidden" id="tallyEmptySub"></div><span class="chip-clear hidden" id="tallyEmptyClearBtn">&#x2715; Clear filter and show all</span></div>' +
        '<div id="tallyResults" class="hidden" style="margin-top:20px;padding:16px;background:#F5F6FD;border:1px solid #D9DDF0;border-radius:10px;"></div>' +
      '</div>' +
    '</div>' +
  '</div>' +

  // ============================================================================
  // AUDITOR DASHBOARD — strictly read-only. Two tabs: a full-detail voucher
  // table (reuses getAllVouchers + the SAME filter/search/sort helpers every
  // other dashboard already uses, via filterBarHtml('auditor')) and a
  // browsable Audit Log. "History" per voucher opens a version-diff modal
  // built from getVoucherEditHistory (Auditor.gs) \u2014 no write action
  // anywhere on this page, by construction: every button here calls a
  // getter RPC, never one that mutates.
  // ============================================================================
  '<div id="auditorPage" class="page">' +
    '<div class="app-container">' +
      '<div class="page-head"><div><h1>Audit Log</h1><div class="sub">Read-only view of vouchers and every recorded action</div></div></div>' +
      '<div class="app-body flat">' +
        '<div id="auditorAlert" class="alert"></div>' +
        '<div class="filters" id="auditorTabBtns">' +
          '<button class="admin-nav-tab active" data-auditor-tab="vouchers">Vouchers</button>' +
          '<button class="admin-nav-tab" data-auditor-tab="log">Audit Log</button>' +
        '</div>' +

        '<div id="auditorTabVouchers" class="auditor-tab-content">' +
          filterBarHtml('auditor') +
          '<div style="display:flex;justify-content:flex-end;margin-bottom:12px;">' +
            '<button class="btn btn-outline btn-sm" id="auditorRefreshBtn">&#x21BB; Refresh</button>' +
          '</div>' +
          '<table class="voucher-table" id="auditorVouchersTable">' +
            '<thead>' +
              '<tr><th rowspan="2">Voucher ID</th><th rowspan="2">Submitted By</th><th rowspan="2" style="text-align:right;">Amount</th><th rowspan="2">Status</th><th colspan="2" style="text-align:center;">Dates</th><th colspan="2" style="text-align:center;">Flags</th><th rowspan="2"></th></tr>' +
              '<tr><th>Voucher</th><th>Bill date</th><th style="text-align:center;">Cash</th><th style="text-align:center;">Tally</th></tr>' +
            '</thead>' +
            '<tbody id="auditorVouchersBody"></tbody>' +
          '</table>' +
          '<div id="auditorVouchersEmptyState" class="empty-state hidden"><div class="icon">&#x1F4C2;</div><div class="title" id="auditorVouchersEmptyTitle">No vouchers match these filters</div><div class="sub hidden" id="auditorVouchersEmptySub"></div><span class="chip-clear hidden" id="auditorVouchersEmptyClearBtn">&#x2715; Clear filter and show all</span></div>' +
        '</div>' +

        '<div id="auditorTabLog" class="auditor-tab-content hidden">' +
          '<div class="filter-bar">' +
            '<div class="filter-bar-row">' +
              '<div class="form-group"><label>Voucher ID</label><input type="text" id="auditLogVoucherId" placeholder="e.g. 6767"></div>' +
              '<div class="form-group"><label>Action</label><input type="text" id="auditLogAction" placeholder="e.g. APPROVE, REJECT, QUERY"></div>' +
              '<div class="form-group"><label>Actor</label><input type="text" id="auditLogActor" placeholder="Name contains..."></div>' +
            '</div>' +
            '<div class="filter-bar-row">' +
              '<div class="filter-bar-actions">' +
                '<button class="btn btn-primary btn-sm" id="auditLogApplyBtn" style="width:auto;">Apply</button>' +
                '<button class="btn btn-outline btn-sm" id="auditLogClearBtn" style="width:auto;">Clear</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="dash-card" id="auditLogTable"><div class="timeline" id="auditLogBody"></div></div>' +
          '<div id="auditLogEmptyState" class="empty-state hidden"><div class="icon">&#x1F4DC;</div><p>No matching log entries</p></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>' +

    '</div>' + // .main
  '</div>' + // #appShell

  // Voucher History / version-diff modal \u2014 chronological timeline for
  // one voucher; entries with a structured before/after snapshot
  // (VOUCHER_EDIT_SNAPSHOT, or the full record on ADMIN_DELETE_VOUCHER)
  // get a "View Changes" toggle showing just the fields that actually
  // differ, not the whole object \u2014 built server-side by
  // parseAuditSnapshotDiff (Auditor.gs), not recomputed here.
  '<div id="auditorHistoryModal" class="modal-overlay">' +
    '<div class="modal-box" style="max-width:700px;"><div class="modal-title">Voucher History \u2014 <span id="auditorHistoryVid"></span></div>' +
    '<div id="auditorHistoryAlert" class="alert"></div>' +
    '<div id="auditorHistoryTallySection" style="margin-bottom:16px;"></div>' +
    '<div id="auditorHistoryTimeline" style="max-height:420px;overflow-y:auto;"></div>' +
    '<div class="modal-buttons"><button class="btn btn-outline" id="closeAuditorHistoryBtn">Close</button></div>' +
    '</div>' +
  '</div>' +

  '<div id="revertModal" class="modal-overlay">' +
    '<div class="modal-box"><div class="modal-title">Revert Voucher</div>' +
    '<p style="color:#454B6B;font-size:14px;margin-bottom:16px;">Voucher: <strong id="revertVid"></strong> \u2014 currently <strong id="revertCurrentStatus"></strong></p>' +
    '<div class="form-group"><label>Send back to</label>' +
      '<select id="revertTargetStage"><option value="L1">Pending L1</option><option value="accounts">Pending Accounts</option><option value="L2">Pending L2</option></select>' +
    '</div>' +
    '<div class="form-group"><label>Reason <span class="req">*</span></label><textarea id="revertReason" rows="3" placeholder="Why is this being reverted?"></textarea></div>' +
    '<div class="modal-buttons"><button class="btn btn-outline" id="cancelRevertBtn">Cancel</button><button class="btn btn-warning" id="confirmRevertBtn">Revert</button></div>' +
    '</div>' +
  '</div>' +

  // Admin-only voucher ID change — blocked server-side once Tally-exported.
  '<div id="changeIdModal" class="modal-overlay">' +
    '<div class="modal-box"><div class="modal-title">Change Voucher ID</div>' +
    '<p style="color:#454B6B;font-size:14px;margin-bottom:16px;">Current ID: <strong id="changeIdOldVid"></strong></p>' +
    '<div id="changeIdAlert" class="alert"></div>' +
    '<div class="form-group"><label>New Voucher ID <span class="req">*</span></label><input type="text" inputmode="numeric" id="changeIdNewVid" placeholder="e.g., 6801"></div>' +
    '<div class="form-group"><label>Reason <span class="req">*</span></label><textarea id="changeIdReason" rows="3" placeholder="Why is this being renumbered?"></textarea></div>' +
    '<div class="modal-buttons"><button class="btn btn-outline" id="cancelChangeIdBtn">Cancel</button><button class="btn btn-warning" id="confirmChangeIdBtn">Change ID</button></div>' +
    '</div>' +
  '</div>' +

  // Admin — complete, irreversible voucher deletion. Reason is always
  // required; the export-override warning starts hidden and is only
  // revealed in place (openDeleteVoucherModal/confirmDeleteVoucher,
  // client JS) if the server reports the voucher was already
  // Tally-exported — a second explicit click is then required to proceed.
  '<div id="deleteVoucherModal" class="modal-overlay">' +
    '<div class="modal-box"><div class="modal-title">Delete Voucher \u2014 Permanent</div>' +
    '<p style="color:#454B6B;font-size:14px;margin-bottom:16px;">Voucher: <strong id="deleteVoucherVid"></strong></p>' +
    '<p style="color:#A84545;font-size:14.5px;margin-bottom:16px;">This removes the voucher entirely from the system. The full record is captured in the Audit Log first, and Drive bill files are renamed (not deleted), but this action cannot be undone from the sheet itself.</p>' +
    '<div id="deleteVoucherAlert" class="alert"></div>' +
    '<div id="deleteVoucherExportWarning" class="alert alert-error hidden" style="font-weight:700;"></div>' +
    '<div class="form-group"><label>Reason <span class="req">*</span></label><textarea id="deleteVoucherReason" rows="3" placeholder="Why is this being deleted?"></textarea></div>' +
    '<div class="confirm-type-box">Type <code id="deleteVoucherConfirmIdHint"></code> below to confirm permanent deletion</div>' +
    '<input type="text" id="deleteVoucherConfirmId" placeholder="Type voucher ID to confirm" style="margin-bottom:10px;">' +
    '<div class="modal-buttons"><button class="btn btn-outline" id="cancelDeleteVoucherBtn">Cancel</button><button class="btn btn-danger" id="confirmDeleteVoucherBtn" disabled>Delete Voucher</button></div>' +
    '</div>' +
  '</div>' +

  // New Vendor Request (per explicit instruction) — submission attaches
  // the vendor's bill; server emails it to whoever's configured under
  // VENDOR_REQUEST_EMAIL (Config.gs), never writes Master Data directly.
  '<div id="requestNewVendorModal" class="modal-overlay">' +
    '<div class="modal-box"><div class="modal-title">Request New Vendor</div>' +
    '<div id="requestVendorAlert" class="alert"></div>' +
    '<div class="form-group"><label>Vendor Name <span class="req">*</span></label><input type="text" id="requestVendorName" placeholder="Exact vendor name"></div>' +
    '<div class="form-group"><label>Vendor Bill <span class="req">*</span></label><input type="file" id="requestVendorFile" accept=".pdf,.jpg,.jpeg,.png,.heic"></div>' +
    '<div class="form-group"><label>Notes</label><textarea id="requestVendorNotes" rows="2" placeholder="TDS applicability, PAN, anything the admin should know (optional)"></textarea></div>' +
    '<div class="modal-buttons"><button class="btn btn-outline" id="cancelRequestVendorBtn">Cancel</button><button class="btn btn-primary" id="confirmRequestVendorBtn">Send Request</button></div>' +
    '</div>' +
  '</div>' +

  // New Employee Request (per explicit instruction) — same modal-and-
  // email pattern as vendor requests above, but deliberately simpler: no
  // file input, since a new employee is a name to add, not a transaction
  // needing a bill to verify.
  '<div id="requestNewEmployeeModal" class="modal-overlay">' +
    '<div class="modal-box"><div class="modal-title">Request New Employee</div>' +
    '<div id="requestEmployeeAlert" class="alert"></div>' +
    '<div class="form-group"><label>Employee Name <span class="req">*</span></label><input type="text" id="requestEmployeeName" placeholder="Full name"></div>' +
    '<div class="form-group"><label>Notes</label><textarea id="requestEmployeeNotes" rows="2" placeholder="Department, cost centre, anything the admin should know (optional)"></textarea></div>' +
    '<div class="modal-buttons"><button class="btn btn-outline" id="cancelRequestEmployeeBtn">Cancel</button><button class="btn btn-primary" id="confirmRequestEmployeeBtn">Send Request</button></div>' +
    '</div>' +
  '</div>' +

  // Edit Vendor (master control) — the whole reason this exists is so
  // Ledger Balance/PAN/Declaration/TDS Applicable/Rate never need a
  // manual sheet edit again. Vendor Name is shown read-only; renaming a
  // vendor isn't supported here (see updateVendorMasterData, Master
  // data.gs, for why).
  '<div id="editVendorModal" class="modal-overlay">' +
    '<div class="modal-box"><div class="modal-title">Edit Vendor \u2014 <span id="editVendorName"></span></div>' +
    '<div id="editVendorAlert" class="alert"></div>' +
    '<div class="grid-2">' +
      '<div class="form-group"><label>TDS Rate (194C fallback)</label>' +
        '<select id="editVendorTdsRate"><option value="">Not Applicable</option><option value="1">1% (Individual / HUF)</option><option value="2">2% (Others)</option></select>' +
        '<div style="font-size:13.5px;color:#454B6B;margin-top:4px;">Used only if PAN is missing/invalid \u2014 a valid PAN always decides the real rate.</div>' +
      '</div>' +
      '<div class="form-group"><label>PAN</label><input type="text" id="editVendorPan" placeholder="e.g., ABCDE1234F" maxlength="10" style="text-transform:uppercase;"></div>' +
    '</div>' +
    '<div class="grid-2">' +
      '<div class="form-group" style="display:flex;align-items:flex-end;padding-bottom:10px;">' +
        '<label style="display:flex;align-items:center;gap:8px;font-weight:400;cursor:pointer;">' +
          '<input type="checkbox" id="editVendorDeclaration"> 194C declaration on file (&lt;11 trucks) \u2014 TDS Not Applicable' +
        '</label>' +
      '</div>' +
      '<div class="form-group"><label>Ledger Balance (Rs.)</label><input type="number" id="editVendorLedgerBalance" min="0" step="0.01"></div>' +
    '</div>' +
    '<div class="modal-buttons"><button class="btn btn-outline" id="cancelEditVendorBtn">Cancel</button><button class="btn btn-primary" id="confirmEditVendorBtn">Save</button></div>' +
    '</div>' +
  '</div>' +

  // Self-service password change (Day 5) — available from any
  // multi-user-role dashboard header. Requires the current password,
  // same as any ordinary "change password" flow.
  '<div id="changePwModal" class="modal-overlay">' +
    '<div class="modal-box"><div class="modal-title">Change Password</div>' +
    '<div id="changePwAlert" class="alert"></div>' +
    '<div class="form-group"><label>Current Password <span class="req">*</span></label>' +
      '<div style="position:relative;"><input type="password" id="changePwOld" autocomplete="current-password" style="width:100%;padding-right:40px;box-sizing:border-box;">' +
      pwEyeToggleHtml('changePwOld') + '</div></div>' +
    '<div class="form-group"><label>New Password <span class="req">*</span></label>' +
      '<div style="position:relative;"><input type="password" id="changePwNew" autocomplete="new-password" placeholder="Min. 8 characters, 1 letter + 1 number" style="width:100%;padding-right:40px;box-sizing:border-box;">' +
      pwEyeToggleHtml('changePwNew') + '</div></div>' +
    '<div class="form-group"><label>Confirm New Password <span class="req">*</span></label>' +
      '<div style="position:relative;"><input type="password" id="changePwConfirm" autocomplete="new-password" style="width:100%;padding-right:40px;box-sizing:border-box;">' +
      pwEyeToggleHtml('changePwConfirm') + '</div></div>' +
    '<div class="modal-buttons"><button class="btn btn-outline" id="cancelChangePwBtn">Cancel</button><button class="btn btn-primary" id="confirmChangePwBtn">Change Password</button></div>' +
    '</div>' +
  '</div>' +

  // MODALS
  '<div id="approveModal" class="modal-overlay">' +
    '<div class="modal-box modal-severity modal-severity-approve"><div class="modal-severity-strip"></div><div class="modal-severity-body">' +
      '<div class="modal-title-flat">Approve voucher</div>' +
      '<p style="color:#454B6B;font-size:14px;margin-bottom:16px;">Approving: <strong id="approveVid"></strong></p>' +
      '<div class="form-group"><label>Notes (optional)</label><textarea id="approveNotes" rows="3" placeholder="Any approval notes..."></textarea></div>' +
      '<div class="modal-buttons">' +
        '<button class="btn btn-outline" id="cancelApproveBtn">Cancel</button>' +
        '<button class="btn btn-success" id="confirmApproveBtn">Approve</button>' +
      '</div>' +
    '</div></div>' +
  '</div>' +

  '<div id="rejectModal" class="modal-overlay">' +
    '<div class="modal-box modal-severity modal-severity-reject"><div class="modal-severity-strip"></div><div class="modal-severity-body">' +
      '<div class="modal-title-flat">Reject voucher</div>' +
      '<p style="color:#454B6B;font-size:14px;margin-bottom:16px;">Rejecting: <strong id="rejectVid"></strong></p>' +
      '<div class="form-group"><label>Reason for rejection <span class="req">*</span></label><textarea id="rejectReason" rows="3" placeholder="Please provide a reason..."></textarea></div>' +
      '<div class="modal-buttons">' +
        '<button class="btn btn-outline" id="cancelRejectBtn">Cancel</button>' +
        '<button class="btn btn-danger" id="confirmRejectBtn">Reject</button>' +
      '</div>' +
    '</div></div>' +
  '</div>' +

  '<div id="queryModal" class="modal-overlay">' +
    '<div class="modal-box"><div class="modal-title">&#x2753; Raise Query</div>' +
      '<p style="color:#454B6B;font-size:14px;margin-bottom:16px;">Voucher: <strong id="queryVid"></strong></p>' +
      '<div class="form-group"><label>Query Type</label>' +
        '<select id="queryType">' +
          '<option value="Actual Expense Date">Actual Expense Date</option>' +
          '<option value="Submitted By">Submitted By</option>' +
          '<option value="Vehicle No.">Vehicle No.</option>' +
          '<option value="Cost Centre">Cost Centre</option>' +
          '<option value="Ledger / Vendor">Ledger / Vendor</option>' +
          '<option value="Amount">Amount</option>' +
          '<option value="Description">Description</option>' +
          '<option value="Bill Files">Bill Files</option>' +
          '<option value="Other">Other (edit entire voucher)</option>' +
        '</select></div>' +
      '<div class="form-group hidden" id="queryLinePickerGroup">' +
        '<label>Which vendor line(s) does this apply to? <span class="req">*</span></label>' +
        '<div id="queryLinePickerList" style="max-height:160px;overflow-y:auto;border:1px solid #D9DDF0;border-radius:6px;padding:8px;"></div>' +
      '</div>' +
      '<div class="form-group"><label>Query Details <span class="req">*</span></label><textarea id="queryDetails" rows="3" placeholder="Describe the issue clearly..."></textarea></div>' +
      '<div class="modal-buttons">' +
        '<button class="btn btn-outline" id="cancelQueryBtn">Cancel</button>' +
        '<button class="btn btn-warning" id="confirmQueryBtn">Raise Query</button>' +
      '</div></div>' +
  '</div>' +

  '<div id="detailModal" class="modal-overlay">' +
    '<div class="modal-box" style="max-width:640px;">' +
      '<div id="detailContent"></div>' +
      '<div class="modal-buttons"><button class="btn btn-outline" id="closeDetailBtn">Close</button></div>' +
    '</div>' +
  '</div>' +

  '<div id="gstModal" class="modal-overlay">' +
    '<div class="modal-box" style="max-width:560px;"><div class="modal-title">GST Entry</div>' +
      '<p style="color:#454B6B;font-size:14px;margin-bottom:12px;">Voucher: <strong id="gstVid"></strong> \u2014 select Yes/No for each vendor as shown on the bill. Every vendor must be explicitly marked before saving.</p>' +
      '<div class="gst-worked-example"><div><div class="eq">\u20B9118 bill = \u20B9100 base + \u20B99 CGST + \u20B99 SGST</div><div class="lbl">CGST/SGST come out of the bill amount \u2014 never add them on top</div></div></div>' +
      // "No GST" bulk-prefill toggle (handoff 2.A) — pre-fills every vendor
      // line on this voucher to No GST / 0/0. Still lands each line on the
      // normal reviewed state (a line can be flipped back to Yes
      // individually afterward) and still requires the ordinary Save GST
      // click to actually persist \u2014 this button touches nothing server-side
      // by itself.
      '<div style="margin-bottom:12px;"><button type="button" class="btn btn-outline" id="noGstBulkBtn" style="font-size:14px;padding:6px 12px;">Mark All No GST</button></div>' +
      '<div id="gstAlert" class="alert"></div>' +
      '<div id="gstLineItems"></div>' +
      '<div class="modal-buttons"><button class="btn btn-outline" id="cancelGstBtn">Cancel</button><button class="btn btn-primary" id="confirmGstBtn">Save GST</button></div>' +
    '</div>' +
  '</div>' +

  // Dual-GST vendor flow for Regular expenses (handoff 2.C). A toggle
  // (off by default, matches "nothing on the submission side" — this
  // whole modal is Accounts-only) reveals a vendor dropdown + CGST/SGST
  // once turned on. TDS is not applicable to this flow (per explicit
  // instruction), so unlike gstModal there's no LR number, no worked
  // TDS example, no per-line list — a Regular voucher is a single
  // amount, not vendor line items.
  '<div id="regularVendorModal" class="modal-overlay">' +
    '<div class="modal-box" style="max-width:480px;"><div class="modal-title">Vendor GST</div>' +
      '<p style="color:#454B6B;font-size:14px;margin-bottom:12px;">Voucher: <strong id="regularVendorVid"></strong> \u2014 route this expense through a vendor if the bill shows GST from a third-party biller.</p>' +
      '<div id="regularVendorAlert" class="alert"></div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;color:#454B6B;font-weight:600;margin-bottom:12px;cursor:pointer;">' +
        '<input type="checkbox" id="regularVendorToggle"> Route through vendor (GST)' +
      '</label>' +
      // "Mark No GST" (item 11) — a Regular voucher is a single amount, not
      // vendor line items, so there's no per-line list to bulk-prefill the
      // way Transport's noGstBulkBtn does; this is the one-click equivalent
      // of leaving the toggle off and saving \u2014 explicitly records
      // AV.REGULAR_VENDOR_ROUTED='No' via the same clearRegularVendorGst
      // RPC saveRegularVendorGstClick already calls for the unchecked-toggle
      // path, so this button is a shortcut into that same code path, not a
      // new one.
      '<div style="margin-bottom:12px;"><button type="button" class="btn btn-outline" id="regularNoGstBtn" style="font-size:14px;padding:6px 12px;">Mark No GST</button></div>' +
      '<div id="regularVendorFields" class="hidden">' +
        '<div class="form-group"><label>Vendor <span class="req">*</span></label><select id="regularVendorName"><option value="">-- Select vendor --</option></select></div>' +
        '<div class="grid-2">' +
          '<div class="form-group"><label>CGST (Rs.)</label><input type="number" id="regularVendorCgst" min="0" step="0.01" placeholder="0.00"></div>' +
          '<div class="form-group"><label>SGST (Rs.)</label><input type="number" id="regularVendorSgst" min="0" step="0.01" placeholder="0.00"></div>' +
        '</div>' +
        '<div id="regularVendorBaseReadout" style="font-size:14px;color:#454B6B;margin-bottom:12px;"></div>' +
      '</div>' +
      '<div class="modal-buttons"><button class="btn btn-outline" id="cancelRegularVendorBtn">Cancel</button><button class="btn btn-primary" id="confirmRegularVendorBtn">Save</button></div>' +
    '</div>' +
  '</div>' +

  // Respond-to-Query modal (Day 3). Shows the actual query text (fetched
  // via getOpenQueryForVoucher) rather than just the short status label —
  // otherwise a submitter would be asked to respond blind to what was
  // actually asked.
  '<div id="respondQueryModal" class="modal-overlay">' +
    '<div class="modal-box"><div class="modal-title">Respond to Query</div>' +
      '<p style="color:#454B6B;font-size:14px;margin-bottom:12px;">Voucher: <strong id="rqVid"></strong></p>' +
      '<div id="rqAlert" class="alert"></div>' +
      '<div id="rqQueryBox" style="background:#ECEEFB;border-radius:6px;padding:10px;font-size:14.5px;color:#454B6B;margin-bottom:16px;"></div>' +
      '<div class="form-group"><label>Your Response <span class="req">*</span></label><textarea id="rqResponse" rows="3" placeholder="Explain or provide the missing information..."></textarea></div>' +
      // Optional bill attachment right in the response — e.g. a "Missing
      // Bills" query is often only really resolved by attaching the bill,
      // not just explaining in text. Uploads into the SAME Drive folder as
      // the voucher\'s other bills.
      '<div class="form-group"><label>Attach a Bill (optional)</label>' +
        '<input type="file" id="rqFiles" multiple accept="image/jpeg,image/png,image/heic,image/heif,image/webp,application/pdf,.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp">' +
        '<div id="rqFileList" class="file-list"></div>' +
      '</div>' +
      '<div class="modal-buttons"><button class="btn btn-outline" id="cancelRqBtn">Cancel</button><button class="btn btn-primary" id="confirmRqBtn">Send Response</button></div>' +
    '</div>' +
  '</div>' +


  // Floating alert — replaces the old static-bar-at-top-of-page behavior.
  // Every showAlert() call now surfaces here instead, centered on screen,
  // impossible to miss or scroll past. The static alert divs (gstAlert,
  // submissionAlert, etc.) still get their className/text updated too, in
  // case anything reads them directly, but they're visually redundant now.
  // Logout confirmation: a stray click on the sidebar button asks first (requestLogout in the js block).
  '<div id="logoutConfirmModal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="logoutConfirmTitle" aria-describedby="logoutConfirmText">' +
  '<div class="modal-box logout-box">' +
  '<div class="logout-icon" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg></div>' +
  '<div class="modal-title-flat" id="logoutConfirmTitle">Log out?</div>' +
  '<p class="logout-text" id="logoutConfirmText">You are logged in as <strong id="logoutWho"></strong>. You will need your username and password to get back in, and anything you have not submitted or saved on this page will be lost.</p>' +
  '<div class="modal-buttons"><button type="button" class="btn btn-outline logout-go" id="logoutConfirmBtn" style="width:auto;">Log out</button><button type="button" class="btn btn-primary" id="logoutStayBtn" style="width:auto;padding-left:22px;padding-right:22px;">Stay logged in</button></div>' +
  '</div>' +
  '</div>' +
  '<div id="floatingAlertOverlay" class="modal-overlay">' +
    '<div class="modal-box floating-alert-box" id="floatingAlertBox">' +
      '<div class="floating-alert-icon" id="floatingAlertIcon"></div>' +
      '<div class="floating-alert-msg" id="floatingAlertMsg"></div>' +
      '<div class="modal-buttons"><button class="btn btn-outline" id="floatingAlertCloseBtn">OK</button></div>' +
    '</div>' +
  '</div>';

  var js = '(function(){\n' +

  'var appToken=null,appRole=null,appDisplayName=null,appDesignation=null,allVouchers=[],vendorCount=0,currentVoucherId=null,currentFilter="all",currentAdminStatusFilter="all",selectedFiles=[],formMaxFiles=25;\n' +
  // Sidebar support data (design pass, sidebar redesign). ROLE_LABELS is
  // display-only; PAGE_ALERT_MAP lets the one sidebar Change Password
  // button show its success/error message on whichever page is actually
  // on screen, reusing each page\'s own existing alert div id \u2014 the
  // same ids openChangePwModal already used per page.\n' +
  'var ROLE_LABELS={submission:"Submitter",L1:"L1 Approver",accounts:"Accounts",L2:"L2 Approver",admin:"Admin",auditor:"Auditor"};\n' +
  'var PAGE_ALERT_MAP={submissionPage:"submissionAlert",myVouchersPage:"myVouchersAlert",submissionDashboardPage:"submissionDashboardAlert",subCashAdvancesPage:"subCashAdvancesAlert",subRecentPage:"subRecentAlert",cashAdvancesPage:"cashAdvancesAlert",dashboardPage:"dashboardAlert",approvalPage:"approvalAlert",adminPage:"adminAlert",tallyExportPage:"tallyAlert",auditorPage:"auditorAlert"};\n' +
  'var currentApprFilters={},currentAdminFilters={},currentTallyFilters={},currentMyVouchersFilters={};\n' +
  // Day 3 edit/resubmit state. editVoucherId===null means the submission
  // form is in plain "new voucher" mode; any other value means it's
  // editing that existing voucher instead (see openEditVoucher/goToNewVoucher).
  'var editVoucherId=null,existingBillFiles=[],removedBillFileUrls=[],_myVouchers=[],currentRqVoucherId=null,currentMyVouchersStatusFilter="all",rqSelectedFiles=[],respondingToQueryVoucherId=null,_adminVendorsCache=[];\n' +
  'var _vendorList=[];\n' +
  'var APPROVAL_ROLES=["L1","accounts","L2"];\n' +

  // Restore session from sessionStorage on page load
  'function restoreSession(){\n' +
  '  var t=sessionStorage.getItem("appToken"),r=sessionStorage.getItem("appRole"),dn=sessionStorage.getItem("appDisplayName"),dg=sessionStorage.getItem("appDesignation");\n' +
  '  if(t&&r){appToken=t;appRole=r;appDisplayName=dn||r;appDesignation=dg||"";routeToRolePage(r);heartbeat();}\n' +
  '}\n' +

  // Rotating welcome quotes and the animated hero were removed in the
  // round-2 design pass (login de-escalation) \u2014 loginQuote/LOGIN_QUOTES
  // no longer exist in the markup, so this block is gone rather than
  // left dead. verifyLogin()/doLogin() and all login field logic below
  // are untouched.

  // submission -> submission dashboard (own landing page; My Vouchers and
  // the submission form are each a button away); admin -> vendor/TDS
  // management; auditor -> read-only Auditor Dashboard; anything else
  // (L1/accounts/L2) -> the shared approval dashboard.
  'function routeToRolePage(role){\n' +
  '  startHeartbeat();\n' +
  '  el("appShell").classList.remove("hidden");\n' +
  '  updateSidebarForRole(role);\n' +
  '  if(role==="submission")loadSubmissionDashboard();\n' +
  '  else if(role==="admin")loadAdminDashboard();\n' +
  '  else if(role==="auditor")loadAuditorDashboard();\n' +
  // CHANGED (#18, design pass): L1/accounts/L2 now land on the overview
  // dashboard first, not straight into the approval queue table \u2014
  // "Go to Approval Queue" on that page hands off to the unchanged
  // loadApprovalDashboard flow below.
  '  else loadDashboard();\n' +
  '}\n' +

  // Sidebar item visibility + identity (design pass, sidebar redesign).
  // data-roles on each .sb-item is the single source of truth for who
  // sees what \u2014 it mirrors the exact role checks routeToRolePage and
  // the old per-page nav-strip already enforced (see the sidebar markup
  // above), so no page becomes reachable here that the role couldn\'t
  // already reach before.
  'function updateSidebarForRole(role){\n' +
  '  document.querySelectorAll(".sb-item,.sb-section-label").forEach(function(it){\n' +
  '    var roles=(it.getAttribute("data-roles")||"").split(",");\n' +
  '    it.classList.toggle("hidden",roles.indexOf(role)===-1);\n' +
  '  });\n' +
  '  var label=ROLE_LABELS[role]||role;\n' +
  '  // The person\'s ACTUAL position in the company (set by an admin under Manage\n' +
  '  // Users); the app role is only the fallback for users with none yet. Hovering\n' +
  '  // shows the app access too, so the two are never confused.\n' +
  '  var shown=appDesignation||label;\n' +
  '  el("sbRole").textContent=shown;\n' +
  '  el("sbRole").title=appDesignation?(appDesignation+" \\u2014 app access: "+label):"";\n' +
  '  var name=appDisplayName||label;\n' +
  '  el("sbName").textContent=name;\n' +
  '  el("sbAvatar").textContent=name.trim().split(/\\s+/).slice(0,2).map(function(w){return w.charAt(0).toUpperCase();}).join("");\n' +
  '}\n' +

  'function el(id){return document.getElementById(id);}\n' +
  'window.el=el;\n' +
  '// Sidebar nav items call these from inline onclick (global scope); IIFE-scoped functions must be exposed.\n' +
  'window.loadSubmissionDashboard=loadSubmissionDashboard;\n' +
  'window.loadSubCashAdvancesPage=loadSubCashAdvancesPage;\n' +
  'window.loadSubRecentPage=loadSubRecentPage;\n' +
  'window.loadDashboard=loadDashboard;\n' +
  'window.goToNewVoucher=goToNewVoucher;\n' +
  'window.loadMyVouchers=loadMyVouchers;\n' +
  'window.loadApprovalDashboard=loadApprovalDashboard;\n' +
  'window.loadCashAdvancesPage=loadCashAdvancesPage;\n' +
  'window.loadTallyExportPage=loadTallyExportPage;\n' +
  'window.loadAdminDashboard=loadAdminDashboard;\n' +
  'window.loadAuditorDashboard=loadAuditorDashboard;\n' +
  'function showPage(id){\n' +
  '  document.querySelectorAll(".page").forEach(function(p){p.classList.remove("active");});\n' +
  '  el(id).classList.add("active");\n' +
  '  document.querySelectorAll(".sb-item").forEach(function(it){it.classList.toggle("active",it.getAttribute("data-page")===id);});\n' +
  '}\n' +
  'function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}\n' +

  // Generic collapse chevron button, reused across every collapsible
  // dash-card (Open Balances, Daily Log, Ledger).
  'function toggleDashCardCollapse(bodyId,btnEl){\n' +
  '  var body=el(bodyId);\n' +
  '  var collapsed=body.classList.toggle("hidden");\n' +
  '  btnEl.innerHTML=collapsed?"&#x25B8;":"&#x25BE;";\n' +
  '  btnEl.title=collapsed?"Expand":"Collapse";\n' +
  '}\n' +
  'window.toggleDashCardCollapse=toggleDashCardCollapse;\n' +

  // updateNavStrips()/the nav-strip click-delegation listener that used to
  // live here were removed (design pass, sidebar redesign) along with the
  // nav-strip markup itself \u2014 navigation to the same four destinations
  // (Dashboard/Approval queue/Tally export/Cash Advances) is now handled
  // once, by the sidebar's own onclick handlers + updateSidebarForRole.

  // Display-only strip of the "IOU - " prefix (#11, design pass). The
  // literal "IOU - Name" string is the REAL stored value everywhere \u2014
  // Master Data\'s employee list, AV.SUBMITTED_BY, and every edit-form
  // <select> option value \u2014 and Tally Export reads that raw sheet value
  // directly, untouched by this file. Stripping it in storage would break
  // employee dropdown preselection and Master Data lookups, and would
  // silently change what Tally exports. So this is applied ONLY at the
  // point of rendering to a read-only table/modal, never to a <select>\'s
  // populated value or anywhere a value round-trips back to the server.\n' +
  // Loading spinner on submit (#1, design pass) — used anywhere a button
  // triggers a server round-trip that can take a few seconds (file
  // upload/compression + Drive write). Swaps innerHTML rather than
  // textContent so the spinner and label render side by side.
  'function setBtnLoading(btn,text){btn.innerHTML=\'<span class="btn-spinner"></span>\'+esc(text);}\n' +
  'function clearBtnLoading(btn,text){btn.textContent=text;}\n' +
  'var _floatingAlertTimer=null;\n' +
  'function showAlert(cid,type,msg){\n' +
  '  setInlineAlert(cid,type,msg);\n' +
  '  showFloatingAlert(type,msg);\n' +
  '}\n' +
  // Inline-only variant — updates the small text banner without popping the\n' +
  // centered floating modal. Used for live/ambient status (e.g. the GST\n' +
  // modal\'s per-line "select yes/no" indicator, which re-evaluates on every\n' +
  // toggle click) where a blocking popup on every interaction would be\n' +
  // disruptive rather than informative. Genuine one-shot errors (failed\n' +
  // saves, server errors) still go through showAlert() above.\n' +
  'function setInlineAlert(cid,type,msg){\n' +
  '  var e=el(cid);e.textContent=msg;e.className="alert alert-"+type+" show";\n' +
  '  setTimeout(function(){e.classList.remove("show");},6000);\n' +
  '}\n' +
  'function showFloatingAlert(type,msg){\n' +
  '  el("floatingAlertBox").className="modal-box floating-alert-box floating-alert-"+type;\n' +
  '  el("floatingAlertIcon").textContent=type==="error"?"\\u26A0":"\\u2713";\n' +
  '  el("floatingAlertMsg").textContent=msg;\n' +
  '  el("floatingAlertOverlay").classList.add("show");\n' +
  '  if(_floatingAlertTimer)clearTimeout(_floatingAlertTimer);\n' +
  '  _floatingAlertTimer=setTimeout(function(){el("floatingAlertOverlay").classList.remove("show");},type==="error"?8000:4000);\n' +
  '}\n' +
  'function closeModal(id){el(id).classList.remove("show");}\n' +

  // displayFn is optional — when given, the option\'s VALUE stays the raw\n' +
  // item string (submitted to the server / stored downstream unchanged),\n' +
  // only its visible textContent is transformed. Used for the employee\n' +
  // dropdown, whose values are literal "IOU - Name" Tally ledger strings\n' +
  // that must NOT change, even though the displayed label should just be\n' +
  // the name.\n' +
  'function populateSelect(id,items,displayFn){\n' +
  '  var s=el(id),blank=s.options.length>0&&s.options[0].value===""?s.options[0].outerHTML:"";\n' +
  '  s.innerHTML=blank;\n' +
  '  (items||[]).forEach(function(v){var o=document.createElement("option");o.value=v;o.textContent=displayFn?displayFn(v):v;s.appendChild(o);});\n' +
  '  if(s._ssInput)syncSSLabel(s);\n' +
  '}\n' +
  // Mirrors stripIouPrefix() in TallyExport.gs (server-side) — display-only,\n' +
  // never applied to the value that actually gets submitted/stored.\n' +
  'function stripIouPrefix(name){return String(name||"").replace(/^IOU\\s*-\\s*/i,"").trim();}\n' +

  // Wraps an already-populated <select> with a type-to-filter text input.
  // The real <select> stays in the DOM (just hidden) and stays the single
  // source of truth for .value, so nothing elsewhere in the app (form
  // validation, submitVoucher, addVendorRow's total calc) needs to change -
  // they keep reading el(id).value exactly as before.
  'function normalizeForSearch(s){return (s||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}\n' +
  // Wraps the first search token\'s matched substring in <mark> for
  // visual scanning of a filtered list of near-identical names \u2014 a
  // simple first-token highlight, not a full multi-token/fuzzy-match
  // renderer, which is enough for the "same word appears twice" case
  // this is actually solving.
  'function highlightMatch(text,filter){\n' +
  '  var tokens=normalizeForSearch(filter).split(" ").filter(Boolean);\n' +
  '  if(!tokens.length)return esc(text);\n' +
  '  var t=tokens[0],idx=text.toLowerCase().indexOf(t.toLowerCase());\n' +
  '  if(idx===-1)return esc(text);\n' +
  '  return esc(text.slice(0,idx))+"<mark>"+esc(text.slice(idx,idx+t.length))+"</mark>"+esc(text.slice(idx+t.length));\n' +
  '}\n' +
  'function makeSearchableSelectEl(sel){\n' +
  '  if(sel._ssInput){syncSSLabel(sel);return;}\n' +
  '  sel.style.display="none";\n' +
  '  var wrap=document.createElement("div");wrap.className="search-select-wrap";\n' +
  '  var input=document.createElement("input");\n' +
  '  input.type="text";input.className="search-select-input";input.autocomplete="off";\n' +
  '  var optCount=0;for(var oi=0;oi<sel.options.length;oi++){if(sel.options[oi].value)optCount++;}\n' +
  '  input.placeholder=optCount?"Type to search "+optCount+" option"+(optCount===1?"":"s")+"...":"Type to search...";\n' +
  '  var chevron=document.createElement("span");chevron.className="search-select-chevron";chevron.textContent="\\u25BE";\n' +
  '  var matchCount=document.createElement("span");matchCount.className="search-select-count hidden";\n' +
  '  var list=document.createElement("div");list.className="search-select-list hidden";\n' +
  '  wrap.appendChild(input);wrap.appendChild(chevron);wrap.appendChild(matchCount);wrap.appendChild(list);\n' +
  '  sel.insertAdjacentElement("afterend",wrap);\n' +
  '  sel._ssInput=input;\n' +
  '  function show(filter){\n' +
  '    var tokens=normalizeForSearch(filter).split(" ").filter(Boolean);\n' +
  '    list.innerHTML="";var any=false;var matched=0;\n' +
  '    for(var i=0;i<sel.options.length;i++){\n' +
  '      var opt=sel.options[i];\n' +
  '      if(!opt.value)continue;\n' +
  '      var optNorm=normalizeForSearch(opt.textContent);\n' +
  '      if(!tokens.every(function(t){return optNorm.indexOf(t)>=0;}))continue;\n' +
  '      any=true;matched++;\n' +
  '      var item=document.createElement("div");item.className="search-select-item";item.innerHTML=highlightMatch(opt.textContent,filter);\n' +
  '      (function(opt){\n' +
  '        item.addEventListener("mousedown",function(e){\n' +
  '          e.preventDefault();\n' +
  '          sel.value=opt.value;input.value=opt.textContent;\n' +
  '          list.classList.add("hidden");\n' +
  '          sel.dispatchEvent(new Event("change"));\n' +
  '        });\n' +
  '      })(opt);\n' +
  '      list.appendChild(item);\n' +
  '    }\n' +
  '    if(!any)list.innerHTML=\'<div class="search-select-empty">No matches</div>\';\n' +
  '    list.classList.remove("hidden");\n' +
  '    matchCount.textContent=matched;\n' +
  '    matchCount.classList.toggle("hidden",!filter);\n' +
  '  }\n' +
  '  input.addEventListener("focus",function(){show(input.value);});\n' +
  '  input.addEventListener("input",function(){show(input.value);});\n' +
  '  input.addEventListener("blur",function(){setTimeout(function(){list.classList.add("hidden");matchCount.classList.add("hidden");syncSSLabel(sel);},150);});\n' +
  '  syncSSLabel(sel);\n' +
  '}\n' +
  'function makeSearchableSelect(id){makeSearchableSelectEl(el(id));}\n' +
  'function setSSDisabled(sel,disabled){\n' +
  '  sel.disabled=disabled;\n' +
  '  if(sel._ssInput){sel._ssInput.disabled=disabled;sel._ssInput.style.background=disabled?"#ECEEFB":"";sel._ssInput.style.cursor=disabled?"not-allowed":"";}\n' +
  '}\n' +
  'function syncSSLabel(sel){\n' +
  '  if(!sel._ssInput)return;\n' +
  '  var opt=sel.options[sel.selectedIndex];\n' +
  '  sel._ssInput.value=(opt&&opt.value)?opt.textContent:"";\n' +
  '}\n' +

  // Login page, logout confirmation and session heartbeat (v3). Source: login.js
  'var HEARTBEAT_MS=' + (SESSION_HEARTBEAT_SECONDS * 1000) + ';\n' +
  '/* ---------- LOGIN PAGE (fluid glass design) + logout confirmation + session heartbeat ---------- */\n' +
  'var LG_ICON={\n' +
  '  error:\'<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M10 6v5M10 14h.01"/></svg>\',\n' +
  '  locked:\'<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="9" width="12" height="8" rx="2"/><path d="M7 9V6a3 3 0 0 1 6 0v3"/></svg>\',\n' +
  '  success:\'<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="m6.5 10.5 2.3 2.3 4.7-5"/></svg>\',\n' +
  '  info:\'<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6h.01"/></svg>\'\n' +
  '};\n' +
  'var LG_VIEWS=["loginFormView","forgotView","resetView","adminCodeView"];\n' +
  'var LG_VIEW_ALERT={loginFormView:"loginAlert",forgotView:"forgotAlert",resetView:"resetAlert",adminCodeView:"adminCodeAlert"};\n' +
  'var LG_REMEMBER_KEY="rds.username";\n' +
  'var lgBusy=false,_resetTimer=null,_hbTimer=null,_admTimer=null,_admChallenge="";\n' +
  '\n' +
  'function lgStore(op,v){\n' +
  '  try{\n' +
  '    if(op==="get")return localStorage.getItem(LG_REMEMBER_KEY);\n' +
  '    if(op==="set")localStorage.setItem(LG_REMEMBER_KEY,v);\n' +
  '    else localStorage.removeItem(LG_REMEMBER_KEY);\n' +
  '  }catch(e){}\n' +
  '  return null;\n' +
  '}\n' +
  'function lgFinePointer(){return !!(window.matchMedia&&window.matchMedia("(pointer: fine)").matches);}\n' +
  '\n' +
  '/* Alerts: text goes in with textContent, never innerHTML; the icons are fixed markup. */\n' +
  'function lgAlert(id,kind,text){\n' +
  '  var b=el(id);b.textContent="";b.removeAttribute("data-kind");\n' +
  '  if(!kind)return;\n' +
  '  b.setAttribute("data-kind",kind);\n' +
  '  var i=document.createElement("span");i.style.display="contents";i.innerHTML=LG_ICON[kind]||LG_ICON.info;\n' +
  '  var m=document.createElement("span");m.textContent=text;\n' +
  '  b.appendChild(i);b.appendChild(m);\n' +
  '}\n' +
  'function lgFieldError(inputId,msg){\n' +
  '  var i=el(inputId),e=el(inputId+"Err");\n' +
  '  if(!i||!e)return;\n' +
  '  if(msg){e.textContent=msg;i.setAttribute("aria-invalid","true");i.setAttribute("aria-describedby",e.id);}\n' +
  '  else{e.textContent="";i.removeAttribute("aria-invalid");i.removeAttribute("aria-describedby");}\n' +
  '}\n' +
  'function lgFlag(inputId,alertId){var i=el(inputId);i.setAttribute("aria-invalid","true");i.setAttribute("aria-describedby",alertId);}\n' +
  'function lgClearView(view){\n' +
  '  lgAlert(LG_VIEW_ALERT[view],null);\n' +
  '  Array.prototype.forEach.call(el(view).querySelectorAll("input"),function(i){if(el(i.id+"Err"))lgFieldError(i.id,"");});\n' +
  '}\n' +
  'function lgSetBusy(btnId,on,text){\n' +
  '  var b=el(btnId),l=b.querySelector(".lg-btn-label");\n' +
  '  if(!b.getAttribute("data-idle"))b.setAttribute("data-idle",l.textContent);\n' +
  '  b.setAttribute("aria-busy",String(on));b.setAttribute("aria-disabled",String(on));\n' +
  '  l.textContent=on?text:b.getAttribute("data-idle");\n' +
  '  lgBusy=on;\n' +
  '}\n' +
  'function showLoginView(name,focus){\n' +
  '  LG_VIEWS.forEach(function(v){el(v).classList.toggle("hidden",v!==name);});\n' +
  '  if(name!=="resetView")clearInterval(_resetTimer);\n' +
  '  if(name!=="adminCodeView")clearInterval(_admTimer);\n' +
  '  if(focus===false)return;\n' +
  '  var fine=lgFinePointer();\n' +
  '  var ids={loginFormView:fine?"loginUsername":"loginTitle",forgotView:fine?"resetUsername":"forgotTitle",resetView:fine?"resetCode":"resetTitle",adminCodeView:fine?"adminCode":"adminCodeTitle"};\n' +
  '  var t=el(ids[name]);if(t)t.focus();\n' +
  '}\n' +
  '\n' +
  '/* ----- log in ----- */\n' +
  '/* takeover===true only from the Admin override button; the click/keydown wiring passes an event object, which is ignored */\n' +
  'function doLogin(takeover){\n' +
  '  if(lgBusy)return;\n' +
  '  takeover=(takeover===true);\n' +
  '  var username=el("loginUsername").value.trim(),secret=el("loginPassword").value;\n' +
  '  lgClearView("loginFormView");el("loginRecovery").classList.add("hidden");el("loginTakeover").classList.add("hidden");\n' +
  '  var first=null;\n' +
  '  if(!username){lgFieldError("loginUsername","Enter your username.");first=el("loginUsername");}\n' +
  '  if(!secret){lgFieldError("loginPassword","Enter your password.");first=first||el("loginPassword");}\n' +
  '  if(first){first.focus();return;}\n' +
  '  lgSetBusy("loginBtn",true,"Logging in\\u2026");\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      lgSetBusy("loginBtn",false);\n' +
  '      if(r&&r.needs2fa){openAdminCodeView(r);return;}\n' +
  '      if(!r||!r.success){\n' +
  '        var kind=(r&&(r.locked||r.alreadyLoggedIn))?"locked":"error";\n' +
  '        lgAlert("loginAlert",kind,(r&&r.error)||"Login failed.");\n' +
  '        if(r&&r.canTakeover){el("loginTakeover").classList.remove("hidden");el("loginTakeoverBtn").focus();return;} /* keep what was typed so one click can override */\n' +
  '        el("loginPassword").value="";\n' +
  '        if(kind==="error"){lgFlag("loginUsername","loginAlert");lgFlag("loginPassword","loginAlert");}\n' +
  '        if(r&&r.locked&&r.selfReset)el("loginRecovery").classList.remove("hidden");\n' +
  '        else el("loginPassword").focus();\n' +
  '        return;\n' +
  '      }\n' +
  '      if(el("loginRemember").checked)lgStore("set",username);else lgStore("del");\n' +
  '      appToken=r.token;appRole=r.role;appDisplayName=r.displayName||r.role;appDesignation=r.designation||"";\n' +
  '      sessionStorage.setItem("appToken",r.token);sessionStorage.setItem("appRole",r.role);sessionStorage.setItem("appDisplayName",appDisplayName);sessionStorage.setItem("appDesignation",appDesignation);\n' +
  '      el("loginPassword").value="";\n' +
  '      routeToRolePage(r.role);\n' +
  '    })\n' +
  '    .withFailureHandler(function(e){lgSetBusy("loginBtn",false);lgAlert("loginAlert","error","Server error: "+e);})\n' +
  '    .verifyLogin(username,secret,takeover);\n' +
  '}\n' +
  '\n' +
  '/* ----- Admin second step: the emailed login code (Auth.gs: verifyAdminSecondFactor, resendAdminSecondFactor) ----- */\n' +
  'function admStartCooldown(seconds){\n' +
  '  var b=el("adminCodeResendBtn"),left=seconds;\n' +
  '  clearInterval(_admTimer);\n' +
  '  b.disabled=true;b.textContent="Send a new code ("+left+"s)";\n' +
  '  _admTimer=setInterval(function(){\n' +
  '    left--;\n' +
  '    if(left<=0){clearInterval(_admTimer);b.disabled=false;b.textContent="Send a new code";}\n' +
  '    else b.textContent="Send a new code ("+left+"s)";\n' +
  '  },1000);\n' +
  '}\n' +
  'function openAdminCodeView(r){\n' +
  '  _admChallenge=r.challengeId||"";\n' +
  '  el("loginPassword").value="";\n' +
  '  lgClearView("adminCodeView");el("adminCodeTakeover").classList.add("hidden");el("adminCode").value="";\n' +
  '  el("adminCodeHint").textContent="We emailed a 6-digit code to "+(r.maskedEmail||"the Admin address")+". It works once and expires in "+(r.expiryMinutes||10)+" minutes.";\n' +
  '  showLoginView("adminCodeView");\n' +
  '  admStartCooldown(r.resendSeconds||30);\n' +
  '}\n' +
  'function admBackToLogin(message){\n' +
  '  _admChallenge="";clearInterval(_admTimer);\n' +
  '  el("adminCode").value="";\n' +
  '  lgClearView("loginFormView");\n' +
  '  showLoginView("loginFormView",false);\n' +
  '  if(message)lgAlert("loginAlert","error",message);\n' +
  '  el("loginPassword").focus();\n' +
  '}\n' +
  '/* takeover===true only from the Admin override button; the click wiring passes an event object, which is ignored */\n' +
  'function doAdminCode(takeover){\n' +
  '  if(lgBusy)return;\n' +
  '  takeover=(takeover===true);\n' +
  '  var code=el("adminCode").value.replace(/[^0-9]/g,"");\n' +
  '  lgClearView("adminCodeView");\n' +
  '  if(!takeover&&code.length!==6){lgFieldError("adminCode","Enter the 6-digit code.");el("adminCode").focus();return;}\n' +
  '  lgSetBusy("adminCodeBtn",true,"Checking\\u2026");\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      lgSetBusy("adminCodeBtn",false);\n' +
  '      if(!r||!r.success){\n' +
  '        if(r&&r.restart){admBackToLogin((r&&r.error)||"Please log in again.");return;}\n' +
  '        lgAlert("adminCodeAlert",(r&&r.alreadyLoggedIn)?"locked":"error",(r&&r.error)||"Login failed.");\n' +
  '        if(r&&r.canTakeover){el("adminCodeTakeover").classList.remove("hidden");el("adminCodeTakeoverBtn").focus();return;}\n' +
  '        el("adminCode").value="";el("adminCode").focus();\n' +
  '        return;\n' +
  '      }\n' +
  '      var username=el("loginUsername").value.trim();\n' +
  '      if(el("loginRemember").checked)lgStore("set",username);else lgStore("del");\n' +
  '      _admChallenge="";clearInterval(_admTimer);\n' +
  '      appToken=r.token;appRole=r.role;appDisplayName=r.displayName||r.role;appDesignation=r.designation||"";\n' +
  '      sessionStorage.setItem("appToken",r.token);sessionStorage.setItem("appRole",r.role);sessionStorage.setItem("appDisplayName",appDisplayName);sessionStorage.setItem("appDesignation",appDesignation);\n' +
  '      el("adminCode").value="";\n' +
  '      routeToRolePage(r.role);\n' +
  '    })\n' +
  '    .withFailureHandler(function(e){lgSetBusy("adminCodeBtn",false);lgAlert("adminCodeAlert","error","Server error: "+e);})\n' +
  '    .verifyAdminSecondFactor(_admChallenge,code,takeover);\n' +
  '}\n' +
  'function doAdminResend(){\n' +
  '  if(lgBusy)return;\n' +
  '  var b=el("adminCodeResendBtn");b.disabled=true;lgAlert("adminCodeAlert",null);\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(r&&r.success){lgAlert("adminCodeAlert","info","A new code is on its way. Only the newest code works.");admStartCooldown(r.resendSeconds||30);return;}\n' +
  '      if(r&&r.restart){admBackToLogin((r&&r.error)||"Please log in again.");return;}\n' +
  '      b.disabled=false;lgAlert("adminCodeAlert","error",(r&&r.error)||"Could not send a new code.");\n' +
  '    })\n' +
  '    .withFailureHandler(function(e){b.disabled=false;lgAlert("adminCodeAlert","error","Server error: "+e);})\n' +
  '    .resendAdminSecondFactor(_admChallenge);\n' +
  '}\n' +
  '/* ----- forgot / reset password (Auth.gs: requestPasswordReset, confirmPasswordReset) ----- */\n' +
  'function resetStartCooldown(seconds){\n' +
  '  var b=el("resetResendBtn"),left=seconds;\n' +
  '  clearInterval(_resetTimer);\n' +
  '  b.disabled=true;b.textContent="Send a new code ("+left+"s)";\n' +
  '  _resetTimer=setInterval(function(){\n' +
  '    left--;\n' +
  '    if(left<=0){clearInterval(_resetTimer);b.disabled=false;b.textContent="Send a new code";}\n' +
  '    else b.textContent="Send a new code ("+left+"s)";\n' +
  '  },1000);\n' +
  '}\n' +
  'function openResetView(prefill){\n' +
  '  clearInterval(_resetTimer);\n' +
  '  lgClearView("forgotView");lgClearView("resetView");\n' +
  '  el("resetUsername").value=prefill||"";\n' +
  '  el("resetCode").value="";el("resetNewPassword").value="";\n' +
  '  updateResetRules();\n' +
  '  showLoginView("forgotView");\n' +
  '}\n' +
  'function requestResetCode(isResend){\n' +
  '  if(lgBusy)return;\n' +
  '  var u=el("resetUsername").value.trim();\n' +
  '  lgClearView("forgotView");\n' +
  '  if(!u){lgFieldError("resetUsername","Enter your username.");el("resetUsername").focus();return;}\n' +
  '  if(isResend){el("resetResendBtn").disabled=true;lgAlert("resetAlert",null);}\n' +
  '  else lgSetBusy("resetSendBtn",true,"Sending code\\u2026");\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!isResend)lgSetBusy("resetSendBtn",false);\n' +
  '      if(!r||!r.success){\n' +
  '        if(isResend)el("resetResendBtn").disabled=false;\n' +
  '        lgAlert(isResend?"resetAlert":"forgotAlert","error",(r&&r.error)||"Could not send the code.");\n' +
  '        return;\n' +
  '      }\n' +
  '      showLoginView("resetView",false);\n' +
  '      lgAlert("resetAlert","info",isResend?"If the account can receive one, a new code is on its way. Only the newest code works.":(r.message||"If that username has an email address on file, a code is on its way."));\n' +
  '      resetStartCooldown(30);\n' +
  '      if(lgFinePointer())el("resetCode").focus();else el("resetTitle").focus();\n' +
  '    })\n' +
  '    .withFailureHandler(function(e){\n' +
  '      if(!isResend)lgSetBusy("resetSendBtn",false);else el("resetResendBtn").disabled=false;\n' +
  '      lgAlert(isResend?"resetAlert":"forgotAlert","error","Server error: "+e);\n' +
  '    })\n' +
  '    .requestPasswordReset(u);\n' +
  '}\n' +
  'function resetRuleState(p){return {len:p.length>=8,mix:/[a-zA-Z]/.test(p)&&/[0-9]/.test(p)};}\n' +
  'function updateResetRules(){\n' +
  '  var st=resetRuleState(el("resetNewPassword").value);\n' +
  '  Array.prototype.forEach.call(el("resetRules").querySelectorAll("li"),function(li){\n' +
  '    var met=!!st[li.getAttribute("data-rule")];\n' +
  '    li.setAttribute("data-met",String(met));\n' +
  '    li.querySelector(".lg-state").textContent=met?" (met)":" (not met)";\n' +
  '  });\n' +
  '}\n' +
  'function confirmResetPassword(){\n' +
  '  if(lgBusy)return;\n' +
  '  var u=el("resetUsername").value.trim(),code=el("resetCode").value.trim(),p=el("resetNewPassword").value;\n' +
  '  lgClearView("resetView");\n' +
  '  var first=null;\n' +
  '  if(!/^[0-9]{6}$/.test(code)){lgFieldError("resetCode","Enter the 6-digit code from the email.");first=el("resetCode");}\n' +
  '  var st=resetRuleState(p);\n' +
  '  if(!st.len||!st.mix){lgFieldError("resetNewPassword","Use at least 8 characters, with a letter and a number.");first=first||el("resetNewPassword");}\n' +
  '  if(first){first.focus();return;}\n' +
  '  lgSetBusy("resetConfirmBtn",true,"Saving\\u2026");\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      lgSetBusy("resetConfirmBtn",false);\n' +
  '      if(!r||!r.success){lgAlert("resetAlert","error",(r&&r.error)||"Could not reset the password.");return;}\n' +
  '      clearInterval(_resetTimer);\n' +
  '      el("resetCode").value="";el("resetNewPassword").value="";updateResetRules();\n' +
  '      el("loginUsername").value=u;el("loginPassword").value="";\n' +
  '      el("loginRecovery").classList.add("hidden");\n' +
  '      showLoginView("loginFormView",false);\n' +
  '      lgAlert("loginAlert","success",r.message||"Your password has been reset. You can log in with it now.");\n' +
  '      el("loginPassword").focus();\n' +
  '    })\n' +
  '    .withFailureHandler(function(e){lgSetBusy("resetConfirmBtn",false);lgAlert("resetAlert","error","Server error: "+e);})\n' +
  '    .confirmPasswordReset(u,code,p);\n' +
  '}\n' +
  '\n' +
  '/* ----- logout: ask first, so a stray click cannot end someone\'s work ----- */\n' +
  'var _logoutOpener=null;\n' +
  'function requestLogout(){\n' +
  '  _logoutOpener=document.activeElement;\n' +
  '  el("logoutWho").textContent=appDisplayName||"";\n' +
  '  el("logoutConfirmModal").classList.add("show");\n' +
  '  el("logoutStayBtn").focus();\n' +
  '}\n' +
  'function closeLogoutConfirm(restoreFocus){\n' +
  '  el("logoutConfirmModal").classList.remove("show");\n' +
  '  if(restoreFocus&&_logoutOpener&&_logoutOpener.focus)_logoutOpener.focus();\n' +
  '  _logoutOpener=null;\n' +
  '}\n' +
  'function logoutConfirmOpen(){return el("logoutConfirmModal").classList.contains("show");}\n' +
  '\n' +
  '/* doLogout ends the session at once. Anything the person does by hand goes through requestLogout first;\n' +
  '   this is also what runs when the server says the session is gone (message explains why). */\n' +
  'function doLogout(msg,kind){\n' +
  '  var t=appToken;\n' +
  '  stopHeartbeat();\n' +
  '  appToken=null;appRole=null;appDisplayName=null;appDesignation=null;allVouchers=[];\n' +
  '  sessionStorage.clear();\n' +
  '  Array.prototype.forEach.call(document.querySelectorAll(".modal-overlay.show"),function(m){m.classList.remove("show");});\n' +
  '  _logoutOpener=null;\n' +
  '  el("appShell").classList.add("hidden");\n' +
  '  el("loginPassword").value="";\n' +
  '  var saved=lgStore("get");\n' +
  '  el("loginUsername").value=saved||"";el("loginRemember").checked=!!saved;\n' +
  '  lgClearView("loginFormView");el("loginRecovery").classList.add("hidden");el("loginTakeover").classList.add("hidden");\n' +
  '  showLoginView("loginFormView",false);\n' +
  '  lgAlert("loginAlert",msg?(kind||"info"):null,msg||"");\n' +
  '  showPage("loginPage");\n' +
  '  if(lgFinePointer())el(saved?"loginPassword":"loginUsername").focus();\n' +
  '  if(t)google.script.run.logout(t);\n' +
  '}\n' +
  '\n' +
  '/* ----- session heartbeat: keeps the account marked "in use" (one login per account) and finds out at once if\n' +
  '   the session was ended (expired, ended by an administrator, replaced, password reset, deactivated) ----- */\n' +
  'var SESSION_END_MESSAGES={\n' +
  '  expired:["Your session expired. Please log in again.","info"],\n' +
  '  ended:["An administrator ended your session. Please log in again.","locked"],\n' +
  '  replaced:["You were logged out because this account was logged in again from somewhere else.","locked"],\n' +
  '  reset:["Your password was reset, so you were logged out. Log in with the new password.","info"],\n' +
  '  deactivated:["Your account has been deactivated. Please contact your administrator.","locked"]\n' +
  '};\n' +
  'function sessionEnded(reason){\n' +
  '  var m=SESSION_END_MESSAGES[reason]||SESSION_END_MESSAGES.expired;\n' +
  '  appToken=null; /* already gone on the server, so there is nothing to log out there */\n' +
  '  doLogout(m[0],m[1]);\n' +
  '}\n' +
  'function heartbeat(){\n' +
  '  if(!appToken)return;\n' +
  '  var tk=appToken;\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){if(tk!==appToken)return;if(r&&r.valid===false)sessionEnded(r.reason);})\n' +
  '    .withFailureHandler(function(){/* offline or busy: try again next time */})\n' +
  '    .touchSession(tk);\n' +
  '}\n' +
  'function startHeartbeat(){stopHeartbeat();_hbTimer=setInterval(heartbeat,HEARTBEAT_MS);}\n' +
  'function stopHeartbeat(){if(_hbTimer){clearInterval(_hbTimer);_hbTimer=null;}}\n' +
  '\n' +
  '/* ----- the flowing edge between the brand area and the form: tint + wave drawn as ONE path at real pixel size ----- */\n' +
  'function drawLoginFluid(){\n' +
  '  var sheet=el("loginSheet"),brand=el("loginBrand"),fluid=el("loginFluid"),probe=el("loginEdgeProbe");\n' +
  '  var W=brand.offsetWidth,H=brand.offsetHeight,E=probe.offsetWidth;\n' +
  '  if(!W||!H||!E)return;\n' +
  '  var split=getComputedStyle(sheet).gridTemplateColumns.trim().split(/\\s+/).length>1;\n' +
  '  var r=Math.min(parseFloat(getComputedStyle(sheet,"::before").borderTopLeftRadius)||28,W/2,H/2);\n' +
  '  function n1(v){return Math.round(v*10)/10;}\n' +
  '  var fill,boundary,shifts,X,Y,move;\n' +
  '  if(split){\n' +
  '    X=function(u){return n1(W+E*u/100);};Y=function(v){return n1(H*v/100);};\n' +
  '    boundary="M"+X(55)+" 0 C"+X(100)+" "+Y(18)+" "+X(10)+" "+Y(34)+" "+X(52)+" "+Y(52)+" S"+X(100)+" "+Y(84)+" "+X(46)+" "+Y(100);\n' +
  '    fill="M"+r+" 0 H"+X(55)+" C"+X(100)+" "+Y(18)+" "+X(10)+" "+Y(34)+" "+X(52)+" "+Y(52)+" S"+X(100)+" "+Y(84)+" "+X(46)+" "+Y(100)+" H"+r+" A"+r+" "+r+" 0 0 1 0 "+n1(H-r)+" V"+r+" A"+r+" "+r+" 0 0 1 "+r+" 0Z";\n' +
  '    shifts=[[0,"#ed1c24",.55,1.2],[13,"#2e3192",.26,1.2],[26,"#2e3192",.13,1.2]];\n' +
  '    fluid.setAttribute("width",W+E);fluid.setAttribute("height",H);fluid.setAttribute("viewBox","0 0 "+(W+E)+" "+H);\n' +
  '    move=function(o){return "translate("+n1(E*o/100)+" 0)";};\n' +
  '  }else{\n' +
  '    X=function(u){return n1(W*u/100);};Y=function(v){return n1(H+E*v/100);};\n' +
  '    boundary="M0 "+Y(40)+" C"+X(24)+" "+Y(84)+" "+X(44)+" "+Y(8)+" "+X(66)+" "+Y(44)+" S"+X(92)+" "+Y(80)+" "+W+" "+Y(52);\n' +
  '    fill="M"+r+" 0 H"+n1(W-r)+" A"+r+" "+r+" 0 0 1 "+W+" "+r+" V"+Y(52)+" C"+X(92)+" "+Y(80)+" "+X(88)+" "+Y(80)+" "+X(66)+" "+Y(44)+" C"+X(44)+" "+Y(8)+" "+X(24)+" "+Y(84)+" 0 "+Y(40)+" V"+r+" A"+r+" "+r+" 0 0 1 "+r+" 0Z";\n' +
  '    shifts=[[0,"#ed1c24",.55,1.2],[12,"#2e3192",.26,1.2],[24,"#2e3192",.13,1.2]];\n' +
  '    fluid.setAttribute("width",W);fluid.setAttribute("height",H+E);fluid.setAttribute("viewBox","0 0 "+W+" "+(H+E));\n' +
  '    move=function(o){return "translate(0 "+n1(E*o/100)+")";};\n' +
  '  }\n' +
  '  var parts=[\'<defs><linearGradient id="lgTintGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7680ee" stop-opacity=".22"/><stop offset="1" stop-color="#7680ee" stop-opacity=".10"/></linearGradient>\'+\n' +
  '    \'<radialGradient id="lgTintGlow" cx="0" cy="0" r="1"><stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>\'+\n' +
  '    \'<clipPath id="lgTintClip"><path d="\'+fill+\'"/></clipPath></defs>\',\n' +
  '    \'<path d="\'+fill+\'" fill="url(#lgTintGrad)" stroke="none"/>\',\n' +
  '    \'<ellipse cx="0" cy="0" rx="\'+n1(W*.6)+\'" ry="\'+n1(H*.5)+\'" fill="url(#lgTintGlow)" stroke="none" clip-path="url(#lgTintClip)"/>\'];\n' +
  '  shifts.forEach(function(s){parts.push(\'<path d="\'+boundary+\'" transform="\'+move(s[0])+\'" stroke="\'+s[1]+\'" stroke-opacity="\'+s[2]+\'" stroke-width="\'+s[3]+\'"/>\');});\n' +
  '  fluid.innerHTML=parts.join("");\n' +
  '  sheet.classList.add("lg-drawn");\n' +
  '}\n' +
  '\n' +
  'function initLoginUi(){\n' +
  '  el("loginTakeoverBtn").addEventListener("click",function(){doLogin(true);});\n' +
  '  el("loginRecoveryResetBtn").addEventListener("click",function(){openResetView(el("loginUsername").value.trim());});\n' +
  '  el("loginForgotBtn").addEventListener("click",function(){openResetView(el("loginUsername").value.trim());});\n' +
  '  el("resetSendBtn").addEventListener("click",function(){requestResetCode(false);});\n' +
  '  el("resetResendBtn").addEventListener("click",function(){requestResetCode(true);});\n' +
  '  el("resetConfirmBtn").addEventListener("click",confirmResetPassword);\n' +
  '  el("forgotBackBtn").addEventListener("click",function(){showLoginView("loginFormView");});\n' +
  '  el("resetBackBtn").addEventListener("click",function(){showLoginView("loginFormView");});\n' +
  '  el("adminCodeBtn").addEventListener("click",function(){doAdminCode(false);});\n' +
  '  el("adminCodeTakeoverBtn").addEventListener("click",function(){doAdminCode(true);});\n' +
  '  el("adminCodeResendBtn").addEventListener("click",doAdminResend);\n' +
  '  el("adminCodeBackBtn").addEventListener("click",function(){admBackToLogin("");});\n' +
  '  el("adminCode").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();doAdminCode(false);}});\n' +
  '  el("adminCode").addEventListener("input",function(){this.value=this.value.replace(/[^0-9]/g,"").slice(0,6);});\n' +
  '  el("resetUsername").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();requestResetCode(false);}});\n' +
  '  el("resetNewPassword").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();confirmResetPassword();}});\n' +
  '  el("resetNewPassword").addEventListener("input",updateResetRules);\n' +
  '  el("resetCode").addEventListener("input",function(){this.value=this.value.replace(/[^0-9]/g,"").slice(0,6);});\n' +
  '  /* logout confirmation */\n' +
  '  el("logoutStayBtn").addEventListener("click",function(){closeLogoutConfirm(true);});\n' +
  '  el("logoutConfirmBtn").addEventListener("click",function(){closeLogoutConfirm(false);doLogout("You have been logged out.","success");});\n' +
  '  el("logoutConfirmModal").addEventListener("click",function(e){if(e.target===el("logoutConfirmModal"))closeLogoutConfirm(true);});\n' +
  '  document.addEventListener("keydown",function(e){\n' +
  '    if(!logoutConfirmOpen())return;\n' +
  '    if(e.key==="Escape"){e.preventDefault();closeLogoutConfirm(true);return;}\n' +
  '    if(e.key==="Tab"){ /* keep focus inside the dialog: first button is "Log out", last is "Stay logged in" (DOM order) */\n' +
  '      var first=el("logoutConfirmBtn"),last=el("logoutStayBtn"),cur=document.activeElement;\n' +
  '      if(e.shiftKey&&(cur===first||cur!==last)){e.preventDefault();last.focus();}\n' +
  '      else if(!e.shiftKey&&cur===last){e.preventDefault();first.focus();}\n' +
  '      else if(cur!==first&&cur!==last){e.preventDefault();last.focus();}\n' +
  '    }\n' +
  '  });\n' +
  '  document.addEventListener("visibilitychange",function(){if(!document.hidden&&appToken)heartbeat();});\n' +
  '  /* remembered username */\n' +
  '  var saved=lgStore("get");\n' +
  '  if(saved){el("loginUsername").value=saved;el("loginRemember").checked=true;}\n' +
  '  /* the flowing edge follows the card\'s real size */\n' +
  '  drawLoginFluid();\n' +
  '  if(window.ResizeObserver)new ResizeObserver(drawLoginFluid).observe(el("loginBrand"));\n' +
  '  window.addEventListener("resize",drawLoginFluid);\n' +
  '  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(drawLoginFluid);\n' +
  '  if(lgFinePointer()&&!appToken)el(saved?"loginPassword":"loginUsername").focus();\n' +
  '}\n' +

  // Fetches form metadata (employees/vehicles/cost centres/ledgers/vendors/
  // maxFiles) and populates the shared submission-form dropdowns. Split out
  // from loadFormData() (below) so My Vouchers' edit flow can call this
  // WITHOUT also navigating to submissionPage — loadFormData is now just a
  // thin wrapper that does both, for the plain "new voucher" case.
  'function fetchFormMetadata(onDone){\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){alert((r&&r.error)||"Failed to load form.");doLogout();return;}\n' +
  '      populateSelect("submittedBy",r.employees,stripIouPrefix);\n' +
  '      formMaxFiles=r.maxFiles||formMaxFiles;\n' +
  '      el("uploadHint").textContent="PDF, JPG, PNG, HEIC or WebP only | Max "+formMaxFiles+" files, 5MB each (images auto-compressed)";\n' +
  '      populateSelect("vehicleNo",r.vehicles);\n' +
  '      populateSelect("costCentre",r.costCentres);\n' +
  '      populateSelect("ledger",r.ledgers);\n' +
  '      ["submittedBy","vehicleNo","costCentre","ledger"].forEach(makeSearchableSelect);\n' +
  '      _vendorList=r.vendors||[];\n' +
  '      if(onDone)onDone(r);\n' +
  '    })\n' +
  '    .withFailureHandler(function(e){alert("Server error: "+e);doLogout();})\n' +
  '    .getFormData(appToken);\n' +
  '}\n' +

  'function loadFormData(){\n' +
  '  fetchFormMetadata(function(r){\n' +
  '    setDateInputFromLocalDate(el("voucherDate"),new Date());\n' +
  '    if(!el("actualExpenseDate").value)setDateInputFromLocalDate(el("actualExpenseDate"),new Date());\n' +
  '    el("actualExpenseDate").max=el("voucherDate").value;\n' +
  '    el("voucherNo").value=r.suggestedVoucherNo||"";\n' + // pre-filled, still fully editable
  '    showPage("submissionPage");\n' +
  '  });\n' +
  '}\n' +

  // ==========================================================================
  // MY VOUCHERS (Day 3, REVISED Day 5) — separate landing page for
  // submission. Shows ALL vouchers by default (the old employee-picker
  // gate hid everything until an employee was chosen, filtering by
  // AV.SUBMITTED_BY — the IOU reimbursement target, unrelated to who's
  // logged in — which made the page useless as a shared team view).
  // "My Submissions" filters by AV.SUBMITTED_BY_OPERATOR (the real logged-
  // in identity now available via Users.gs) — purely a VIEW filter, never
  // a permission restriction: any submission-role login can still edit or
  // respond to a query on ANY voucher regardless of who originally
  // submitted it, so people can cover for each other. Uses its own
  // _myVouchers cache (not the shared allVouchers var the approval
  // dashboard uses), matching how admin and Tally Export already keep
  // their own separate per-page caches.
  // ==========================================================================
  'var currentMyVouchersOwner="all";\n' +

  // ==========================================================================
  // SUBMISSION LANDING DASHBOARD — default landing page for the
  // submission role (see routeToRolePage above). One RPC
  // (getSubmissionDashboardSummary, Approval.gs), scoped server-side to
  // this operator's own vouchers — mirrors loadDashboard/renderDashboard
  // below for L1/accounts/L2/admin, but deliberately its own function
  // rather than a shared one: the two pages show different data (personal
  // vs company-wide) and have no markup in common beyond the .dash-stats/
  // .dash-card CSS classes.
  // ==========================================================================
  'var SUBDASH_PALETTE=["#2E3192","#B8791E","#C0433F","#5A8FC9","#B79B4B"];\n' +
  'var _subDash={balances:null,balancesError:"",cash:null,cashError:"",ageFlagDays:30};\n' +
  'function subDashMoney(n){return "Rs. "+Math.round(n).toLocaleString("en-IN");}\n' +
  'function subDashLoading(id){el(id).innerHTML=\'<div class="sd-empty">Loading...</div>\';}\n' +
  'function subDashMessage(id,text){el(id).innerHTML=\'<div class="sd-empty">\'+esc(text)+\'</div>\';}\n' +
  'function loadSubmissionDashboard(){\n' +
  '  showPage("submissionDashboardPage");\n' +
  '  el("submissionDashboardAlert").className="alert";\n' +
  '  _subDash={balances:null,balancesError:"",cash:null,cashError:"",ageFlagDays:30};\n' +
  '  ["subDashCashPieWrap","subDashAdvPieWrap","subDashAttentionWrap","subDashStagesWrap","subDashOldestWrap","subDashDailyWrap"].forEach(function(id){subDashLoading(id);});\n' +
  '  el("subDashCashPieNote").textContent="";el("subDashAdvPieNote").textContent="";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){\n' +
  '        showAlert("submissionDashboardAlert","error",(r&&r.error)||"Failed to load dashboard.");\n' +
  '        subDashMessage("subDashAttentionWrap","Could not load.");subDashMessage("subDashStagesWrap","Could not load.");\n' +
  '        return;\n' +
  '      }\n' +
  '      renderSubmissionDashboard(r);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){\n' +
  '      showAlert("submissionDashboardAlert","error","Server error: "+err);\n' +
  '      subDashMessage("subDashAttentionWrap","Could not load.");subDashMessage("subDashStagesWrap","Could not load.");\n' +
  '    })\n' +
  '    .getSubmissionDashboardSummary(appToken);\n' +
  '  fetchSubDashAdvances();\n' +
  '  fetchSubDashCash();\n' +
  '  fetchSubDashDaily();\n' +
  '}\n' +
  'function renderSubmissionDashboard(r){\n' +
  '  el("subDashStatPending").textContent=r.myPending.count;\n' +
  '  el("subDashStatQueries").textContent=r.myOpenQueries.count;\n' +
  '  el("subDashStatSubmitted").textContent=r.myMonthSubmitted.count;\n' +
  '  el("subDashStatSubmittedSub").textContent="Rs. "+r.myMonthSubmitted.amount.toLocaleString("en-IN")+" this month";\n' +
  '  el("subDashStatApproved").textContent="Rs. "+r.myMonthApproved.amount.toLocaleString("en-IN");\n' +
  '  el("subDashStatApprovedSub").textContent=r.myMonthApproved.count+" voucher(s) this month";\n' +
  '  renderSubDashAttention(r);\n' +
  '  renderSubDashStages(r.stages||{});\n' +
  '}\n' +
  'function renderSubDashAttention(r){\n' +
  '  var rows=r.attention||[],total=r.attentionCount||0,wrap=el("subDashAttentionWrap");\n' +
  '  el("subDashAttentionTitle").textContent="Needs your attention"+(total>0?" ("+total+")":"");\n' +
  '  if(rows.length===0){wrap.innerHTML=\'<div class="sd-empty">Nothing needs your attention right now: no open queries and no rejected vouchers.</div>\';return;}\n' +
  '  var html=rows.map(function(v){\n' +
  '    var hasQuery=v.queryStatus&&v.queryStatus!=="No Query";\n' +
  '    return \'<div class="sd-att-row"><span class="id">\'+esc(v.voucherId)+\'</span><span class="meta">\'+esc(v.expenseType)+(v.date?" \\u00b7 "+esc(v.date):"")+\'</span><span class="amt">\'+subDashMoney(v.amount)+\'</span>\'+statusChipHtml(v.status,hasQuery)+\'</div>\';\n' +
  '  }).join("");\n' +
  '  if(total>rows.length)html+=\'<div class="sd-empty" style="padding:10px 0 0;">+\'+(total-rows.length)+\' more in My Vouchers</div>\';\n' +
  '  wrap.innerHTML=html;\n' +
  '}\n' +
  'function renderSubDashStages(st){\n' +
  '  var items=[\n' +
  '    ["Pending L1",st.pendingL1||0,"#2E3192"],["Pending Accounts",st.pendingAccounts||0,"#5A8FC9"],["Pending L2",st.pendingL2||0,"#B79B4B"],\n' +
  '    ["Open queries",st.openQueries||0,"#B8791E"],["Rejected",st.rejected||0,"#C0433F"],["Approved this month",st.approvedThisMonth||0,"#2F7D5C"]\n' +
  '  ];\n' +
  '  var max=1;items.forEach(function(it){if(it[1]>max)max=it[1];});\n' +
  '  el("subDashStagesWrap").innerHTML=items.map(function(it){\n' +
  '    return \'<div class="sd-bar-row"><span class="nm">\'+esc(it[0])+\'</span><span class="sd-bar"><i style="width:\'+Math.round(it[1]/max*100)+\'%;background:\'+it[2]+\'"></i></span><span class="ct">\'+it[1]+\'</span></div>\';\n' +
  '  }).join("");\n' +
  '}\n' +
  'function subDashPieHtml(slices){\n' +
  '  var drawn=slices.filter(function(s){return s.amount>0.004;});\n' +
  '  var total=drawn.reduce(function(t,s){return t+s.amount;},0);\n' +
  '  var svg="",angle=-90;\n' +
  '  if(drawn.length===1){svg=\'<circle cx="70" cy="70" r="70" fill="\'+drawn[0].color+\'"><title>\'+esc(drawn[0].label)+\': \'+subDashMoney(drawn[0].amount)+\'</title></circle>\';}\n' +
  '  else{\n' +
  '    drawn.forEach(function(s){\n' +
  '      var sweep=s.amount/total*360,a1=angle*Math.PI/180,a2=(angle+sweep)*Math.PI/180;\n' +
  '      var x1=70+70*Math.cos(a1),y1=70+70*Math.sin(a1),x2=70+70*Math.cos(a2),y2=70+70*Math.sin(a2);\n' +
  '      svg+=\'<path d="M70 70 L\'+x1.toFixed(2)+\' \'+y1.toFixed(2)+\' A70 70 0 \'+(sweep>180?1:0)+\' 1 \'+x2.toFixed(2)+\' \'+y2.toFixed(2)+\' Z" fill="\'+s.color+\'"><title>\'+esc(s.label)+\': \'+subDashMoney(s.amount)+\'</title></path>\';\n' +
  '      angle+=sweep;\n' +
  '    });\n' +
  '  }\n' +
  '  var legend=slices.map(function(s){\n' +
  '    var pct=(total>0&&s.amount>0.004)?" ("+Math.round(s.amount/total*100)+"%)":"";\n' +
  '    return \'<div class="dash-pie-legend-item"><span class="dash-pie-legend-swatch" style="background:\'+s.color+\'"></span>\'+esc(s.label)+" \\u2014 "+subDashMoney(s.amount)+pct+"</div>";\n' +
  '  }).join("");\n' +
  '  return \'<div class="dash-pie-row"><svg width="140" height="140" viewBox="0 0 140 140" style="flex-shrink:0">\'+svg+\'</svg><div class="dash-pie-legend">\'+legend+"</div></div>";\n' +
  '}\n' +
  'function subDashOpenBalances(){return (_subDash.balances||[]).filter(function(b){return b.openBalance>0.004;});}\n' +
  'function fetchSubDashAdvances(){\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){_subDash.balancesError=(r&&r.error)||"Failed to load advances.";}\n' +
  '      else{_subDash.balances=r.balances||[];_subDash.ageFlagDays=r.ageFlagDays||30;}\n' +
  '      renderSubDashAdvances();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){_subDash.balancesError="Server error: "+err;renderSubDashAdvances();})\n' +
  '    .getCashAdvanceBalances(appToken);\n' +
  '}\n' +
  'function renderSubDashAdvances(){\n' +
  '  if(_subDash.balancesError){\n' +
  '    el("subDashStatAdvances").textContent="\\u2014";el("subDashStatAdvancesSub").textContent="";\n' +
  '    subDashMessage("subDashAdvPieWrap",_subDash.balancesError);subDashMessage("subDashOldestWrap",_subDash.balancesError);\n' +
  '    renderSubDashCashPie();\n' +
  '    return;\n' +
  '  }\n' +
  '  var all=_subDash.balances||[],open=subDashOpenBalances();\n' +
  '  var openTotal=open.reduce(function(s,b){return s+b.openBalance;},0);\n' +
  '  var flagged=all.filter(function(b){return b.flagged;}).length;\n' +
  '  el("subDashStatAdvances").textContent="Rs. "+openTotal.toLocaleString("en-IN");\n' +
  '  el("subDashStatAdvancesSub").textContent=flagged>0?(flagged+" flagged \\u2014 open too long"):(open.length+" open");\n' +
  '  var sorted=open.slice().sort(function(a,b){return b.openBalance-a.openBalance;});\n' +
  '  if(sorted.length===0){\n' +
  '    subDashMessage("subDashAdvPieWrap","No open advances. Everything given out has been covered by vouchers.");\n' +
  '    el("subDashAdvPieNote").textContent="";\n' +
  '    subDashMessage("subDashOldestWrap","No open advances.");\n' +
  '  }else{\n' +
  '    var slices=sorted.slice(0,5).map(function(b,i){return {label:stripIouPrefix(b.givenTo),amount:b.openBalance,color:SUBDASH_PALETTE[i]};});\n' +
  '    var rest=sorted.slice(5);\n' +
  '    if(rest.length>0)slices.push({label:"Others ("+rest.length+")",amount:rest.reduce(function(s,b){return s+b.openBalance;},0),color:"#5F6684"});\n' +
  '    el("subDashAdvPieWrap").innerHTML=subDashPieHtml(slices);\n' +
  '    el("subDashAdvPieNote").textContent="Open balance per person: advances given minus vouchers filed against them.";\n' +
  '    var oldest=open.slice().sort(function(a,b){return b.ageDays-a.ageDays;}).slice(0,5);\n' +
  '    el("subDashOldestWrap").innerHTML=oldest.map(function(b){\n' +
  '      var col=b.flagged?"#A84545":(b.ageDays>14?"#8A5A17":"#454B6B");\n' +
  '      return \'<div class="sd-att-row"><span class="meta" style="color:var(--text);font-weight:600;">\'+esc(stripIouPrefix(b.givenTo))+\'</span><span class="amt">\'+subDashMoney(b.openBalance)+\'</span><span style="min-width:84px;text-align:right;font-weight:600;color:\'+col+\'">\'+b.ageDays+\' day(s)\'+(b.flagged?" \\u26A0":"")+\'</span></div>\';\n' +
  '    }).join("")+\'<div class="sd-empty" style="padding:10px 0 0;">Flagged once open for more than \'+_subDash.ageFlagDays+\' days.</div>\';\n' +
  '  }\n' +
  '  renderSubDashCashPie();\n' +
  '}\n' +
  'function fetchSubDashCash(){\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){_subDash.cashError=(r&&r.error)||"Could not read Cash in Hand.";}\n' +
  '      else{_subDash.cash=r;}\n' +
  '      renderSubDashCashPie();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){_subDash.cashError="Server error: "+err;renderSubDashCashPie();})\n' +
  '    .getSubmissionCashPosition(appToken);\n' +
  '}\n' +
  'function renderSubDashCashPie(){\n' +
  '  var wrap=el("subDashCashPieWrap"),note=el("subDashCashPieNote");\n' +
  '  if(_subDash.cashError){subDashMessage("subDashCashPieWrap",_subDash.cashError);note.textContent="";return;}\n' +
  '  if(_subDash.balancesError){subDashMessage("subDashCashPieWrap","Advances could not be loaded, so there is nothing to compare Cash in Hand with.");note.textContent="";return;}\n' +
  '  if(!_subDash.cash||!_subDash.balances)return;\n' +
  '  if(!_subDash.cash.available){subDashMessage("subDashCashPieWrap","No Cash in Hand balance found in Rabale Daily Sync yet.");note.textContent="";return;}\n' +
  '  var adv=subDashOpenBalances().reduce(function(s,b){return s+b.openBalance;},0);\n' +
  '  wrap.innerHTML=subDashPieHtml([\n' +
  '    {label:"Cash in hand",amount:_subDash.cash.cashInHand,color:SUBDASH_PALETTE[0]},\n' +
  '    {label:"Advances outstanding",amount:adv,color:SUBDASH_PALETTE[1]}\n' +
  '  ]);\n' +
  '  note.textContent="Cash in hand"+(_subDash.cash.asOf?" as of "+_subDash.cash.asOf:"")+", from Rabale Daily Sync ("+_subDash.cash.tab+"). The two figures are compared side by side; neither is subtracted from the other.";\n' +
  '}\n' +
  'function fetchSubDashDaily(){\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){subDashMessage("subDashDailyWrap",(r&&r.error)||"Failed to load.");return;}\n' +
  '      renderSubDashDaily(r.days||[]);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){subDashMessage("subDashDailyWrap","Server error: "+err);})\n' +
  '    .getCashAdvanceDailyBreakdown(7,appToken);\n' +
  '}\n' +
  'function subDashDayKey(d){\n' +
  '  function p(n){return (n<10?"0":"")+n;}\n' +
  '  return p(d.getDate())+"-"+p(d.getMonth()+1)+"-"+d.getFullYear();\n' +
  '}\n' +
  'function renderSubDashDaily(serverDays){\n' +
  '  var byDate={};\n' +
  '  serverDays.forEach(function(d){byDate[d.date]=d;});\n' +
  '  var days=[],max=0,totA=0,totV=0;\n' +
  '  for(var i=6;i>=0;i--){\n' +
  '    var dt=new Date();dt.setDate(dt.getDate()-i);\n' +
  '    var k=subDashDayKey(dt),s=byDate[k]||{advanceTotal:0,voucherTotal:0};\n' +
  '    var d={label:k.substr(0,5).replace("-","/"),adv:s.advanceTotal||0,vou:s.voucherTotal||0};\n' +
  '    days.push(d);max=Math.max(max,d.adv,d.vou);totA+=d.adv;totV+=d.vou;\n' +
  '  }\n' +
  '  var wrap=el("subDashDailyWrap");\n' +
  '  if(max<=0){wrap.innerHTML=\'<div class="sd-empty">No advances given and no vouchers filed in the last 7 days.</div>\';return;}\n' +
  '  var W=560,H=170,base=140,bw=24,gw=W/7,svg=\'<line x1="0" y1="\'+base+\'" x2="\'+W+\'" y2="\'+base+\'" stroke="#D9DDF0"/>\';\n' +
  '  days.forEach(function(d,i){\n' +
  '    var x0=i*gw+(gw-2*bw-4)/2,ha=Math.round(d.adv/max*(base-10)),hv=Math.round(d.vou/max*(base-10));\n' +
  '    svg+=\'<rect x="\'+x0.toFixed(1)+\'" y="\'+(base-ha)+\'" width="\'+bw+\'" height="\'+ha+\'" rx="3" fill="#B8791E"><title>\'+d.label+\' advances given: \'+subDashMoney(d.adv)+\'</title></rect>\';\n' +
  '    svg+=\'<rect x="\'+(x0+bw+4).toFixed(1)+\'" y="\'+(base-hv)+\'" width="\'+bw+\'" height="\'+hv+\'" rx="3" fill="#2E3192"><title>\'+d.label+\' vouchers filed: \'+subDashMoney(d.vou)+\'</title></rect>\';\n' +
  '    svg+=\'<text x="\'+(i*gw+gw/2).toFixed(1)+\'" y="\'+(base+18)+\'" text-anchor="middle" font-size="11" fill="#454B6B">\'+d.label+\'</text>\';\n' +
  '  });\n' +
  '  wrap.innerHTML=\'<svg viewBox="0 0 \'+W+\' \'+H+\'" style="width:100%;height:auto;max-height:210px;">\'+svg+\'</svg>\'+\n' +
  '    \'<div style="display:flex;gap:18px;flex-wrap:wrap;font-size:13px;margin-top:6px;">\'+\n' +
  '    \'<span class="dash-pie-legend-item"><span class="dash-pie-legend-swatch" style="background:#B8791E"></span>Advances given \\u2014 \'+subDashMoney(totA)+\'</span>\'+\n' +
  '    \'<span class="dash-pie-legend-item"><span class="dash-pie-legend-swatch" style="background:#2E3192"></span>Vouchers filed \\u2014 \'+subDashMoney(totV)+\'</span></div>\';\n' +
  '}\n' +
  'function loadSubCashAdvancesPage(){\n' +
  '  showPage("subCashAdvancesPage");\n' +
  '  el("subCashAdvancesAlert").className="alert";\n' +
  '  loadCashAdvancesEntryForm();\n' +
  '  fetchCashAdvancesBalancesInto("subDashAdvancesBalancesBody","subDashAdvancesBalancesEmpty","subDashAdvancesBalancesTable","subDashAdvancesLedgerPerson",true);\n' +
  '  fetchCashAdvanceDailyLog("subDashCa","subCashAdvancesAlert");\n' +
  '}\n' +
  'function loadSubRecentPage(){\n' +
  '  showPage("subRecentPage");\n' +
  '  el("subRecentAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("subRecentAlert","error",(r&&r.error)||"Failed to load recent submissions.");return;}\n' +
  '      renderSubRecent(r.recentVouchers||[]);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("subRecentAlert","error","Server error: "+err);})\n' +
  '    .getSubmissionDashboardSummary(appToken);\n' +
  '}\n' +
  'function renderSubRecent(rows){\n' +
  '  var tbody=el("subDashRecentBody"),empty=el("subDashRecentEmpty"),table=el("subDashRecentTable");\n' +
  '  tbody.innerHTML="";\n' +
  '  if(rows.length===0){table.style.display="none";empty.classList.remove("hidden");return;}\n' +
  '  empty.classList.add("hidden");table.style.display="";\n' +
  '  rows.forEach(function(v){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    var hasQuery=v.queryStatus&&v.queryStatus!=="No Query";\n' +
  '    tr.innerHTML="<td>"+esc(v.voucherId)+"</td><td>"+esc(v.date)+"</td><td>"+esc(v.expenseType)+"</td><td>Rs. "+Math.round(v.amount).toLocaleString("en-IN")+"</td><td>"+statusChipHtml(v.status,hasQuery)+"</td>";\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '}\n' +

  'function loadMyVouchers(){\n' +
  '  exitEditMode();\n' +
  '  showPage("myVouchersPage");\n' +
  '  fetchFormMetadata(function(){ fetchMyVouchers(); });\n' +
  '}\n' +

  'function fetchMyVouchers(){\n' +
  '  el("myVouchersAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("myVouchersAlert","error",(r&&r.error)||"Failed to load vouchers.");return;}\n' +
  '      _myVouchers=r.vouchers;\n' +
  '      populateBatchIdOptions("myv",_myVouchers);\n' +
  '      updateMyVouchersQueryDot();\n' +
  '      renderMyVouchers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("myVouchersAlert","error","Server error: "+err);})\n' +
  '    .getAllVouchers(appToken);\n' +
  '}\n' +

  // Red dot on the Query filter tab whenever at least one voucher (across
  // all submitters, not just "My Submissions" -- the myvOwnerBtns filter
  // is a separate axis) has an open, unresponded query. Purely a visual
  // cue on top of the existing Query tab; no new data source, no polling
  // of its own -- it rides fetchMyVouchers' existing 60s auto-refresh
  // (see the setInterval near the bottom of this file) and every place
  // that already calls fetchMyVouchers() after a query is responded to.
  'function updateMyVouchersQueryDot(){\n' +
  '  var dot=el("myvQueryDot");\n' +
  '  if(!dot)return;\n' +
  '  var hasOpenQuery=_myVouchers.some(function(v){return v.queryStatus&&v.queryStatus!=="No Query";});\n' +
  '  dot.classList.toggle("hidden",!hasOpenQuery);\n' +
  '}\n' +

  // REMOVED (bugfix round) — the in-app notification bell (updateQueryNotifBadge)
  // duplicated the "Query" filter tab on this same page and told nobody
  // anything they couldn\'t already see there. Replaced with a real email
  // channel instead: sendSameDayQueryReminders (Triggers.gs) notifies every
  // active submission user at SAME_DAY_QUERY_REMINDER_HOUR if a query
  // raised today is still open.

  'function renderMyVouchers(){\n' +
  '  var tbody=el("myVouchersBody"),empty=el("myVouchersEmptyState"),table=el("myVouchersTable");\n' +
  '  tbody.innerHTML="";\n' +
  '  var rows=_myVouchers.filter(function(v){\n' +
  '    if(currentMyVouchersOwner==="mine"&&v.submittedByOperator!==appDisplayName)return false;\n' +
  '    if(currentMyVouchersStatusFilter!=="all"){\n' +
  '      if(currentMyVouchersStatusFilter==="Query"){if(!(v.queryStatus&&v.queryStatus!=="No Query"))return false;}\n' +
  '      else if(v.status!==currentMyVouchersStatusFilter)return false;\n' +
  '    }\n' +
  '    return voucherMatchesFilters(v,currentMyVouchersFilters);\n' +
  '  });\n' +
  '  rows=sortVouchers(rows,el("myvSortBy").value);\n' +
  '  if(rows.length===0){\n' +
  '    table.style.display="none";\n' +
  '    var myvDefaultMsg=(currentMyVouchersOwner==="mine")?"You haven\\u2019t submitted any vouchers matching this filter.":"No vouchers found.";\n' +
  '    setEmptyStateFilterInfo("myVouchersEmptyTitle","myVouchersEmptySub","myVouchersEmptyClearBtn",myvDefaultMsg,currentMyVouchersStatusFilter!=="all"?currentMyVouchersStatusFilter:null,function(){document.querySelector(\'#myvFilterBtns [data-filter="all"]\').click();});\n' +
  '    empty.classList.remove("hidden");\n' +
  '    return;\n' +
  '  }\n' +
  '  empty.classList.add("hidden");table.style.display="";\n' +
  '  rows.forEach(function(v){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    var hasQuery=v.queryStatus&&v.queryStatus!=="No Query";\n' +
  // Same eligibility rule enforced server-side in getVoucherForEdit /
  // resubmitVoucher (EDITABLE_STATUSES) — mirrored here purely so the
  // button doesn\'t appear for a voucher that would just be rejected by
  // the server anyway; the server check is still authoritative. CHANGED
  // (bugfix round): Edit no longer shows for a plain Pending L1 voucher —
  // only Rejected. A voucher with an open query gets "Respond to Query"
  // instead (below), which is a separate, category-scoped edit flow.
  '    var editable=(v.status==="Rejected");\n' +
  '    var btns=\'<button class="btn btn-outline btn-sm" data-myv-action="view" data-vid="\'+esc(v.voucherId)+\'">View</button>\';\n' +
  '    if(editable)btns+=\'<button class="btn btn-outline btn-sm" data-myv-action="edit" data-vid="\'+esc(v.voucherId)+\'">Edit</button>\';\n' +
  '    if(hasQuery)btns+=\'<button class="btn btn-warning btn-sm" data-myv-action="respond" data-vid="\'+esc(v.voucherId)+\'">Respond to Query</button>\';\n' +
  '    tr.innerHTML=\'<td>\'+vdChainMiniHtml(v)+\'</td><td>\'+statusChipHtml(v.status,false)+\'</td>\'+\n' +
  '      "<td><strong>"+esc(v.voucherId)+"</strong></td><td>"+esc(v.date)+"</td><td>"+esc(v.expenseType)+"</td>"+\n' +
  '      \'<td class="amt-cell">Rs. \'+v.amount.toLocaleString("en-IN")+"</td>"+\n' +
  '      "<td>"+(hasQuery?esc(v.queryStatus):"\\u2014")+"</td>"+\n' +
  '      \'<td><div class="action-btns">\'+btns+\'</div></td>\';\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '  tbody.querySelectorAll("[data-myv-action]").forEach(function(b){\n' +
  '    b.addEventListener("click",function(){\n' +
  '      var vid=b.getAttribute("data-vid"),action=b.getAttribute("data-myv-action");\n' +
  '      if(action==="view")viewDetail(vid,_myVouchers);\n' +
  '      else if(action==="edit")openEditVoucher(vid);\n' +
  '      else if(action==="respond")openRespondToQueryFlow(vid);\n' +
  '    });\n' +
  '  });\n' +
  '}\n' +

  // ==========================================================================
  // EDIT / RESUBMIT — reuses the existing submission form markup/JS. When
  // editVoucherId is set, submitVoucher() (below) calls resubmitVoucher
  // instead of saveVoucherSubmission, and the "at least one file" check
  // counts remaining-existing + new instead of just new.
  // ==========================================================================
  'function openEditVoucher(voucherId){\n' +
  '  el("myVouchersAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("myVouchersAlert","error",(r&&r.error)||"Failed to load voucher.");return;}\n' +
  '      fetchFormMetadata(function(){ enterEditMode(r); });\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("myVouchersAlert","error","Server error: "+err);})\n' +
  '    .getVoucherForEdit(voucherId,appToken);\n' +
  '}\n' +

  'function enterEditMode(v){\n' +
  '  editVoucherId=v.voucherId;\n' +
  '  existingBillFiles=(v.billFiles||[]).slice();\n' +
  '  removedBillFileUrls=[];\n' +
  '  selectedFiles=[];\n' +
  '  el("voucherNo").value=v.voucherId;el("voucherNo").disabled=true;\n' +
  '  var d=parseDMY(v.date);\n' +
  '  if(d)setDateInputFromLocalDate(el("voucherDate"),d);\n' +
  // Actual Expense Date's cap is TODAY (the real calendar day right now),
  // not the voucher's original submission date \u2014 the server validates
  // against actual "today" too (isFutureCalendarDate, Vouchers.gs), so an
  // old voucher being edited weeks later can still have its bill date
  // moved forward up to today, just never past it.
  '  el("actualExpenseDate").max=new Date().getFullYear()+"-"+String(new Date().getMonth()+1).padStart(2,"0")+"-"+String(new Date().getDate()).padStart(2,"0");\n' +
  '  var aed=parseDMY(v.actualExpenseDate||v.date);\n' +
  '  if(aed)setDateInputFromLocalDate(el("actualExpenseDate"),aed);\n' +
  '  el("submittedBy").value=v.submittedBy;syncSSLabel(el("submittedBy"));\n' +
  '  el("costCentre").value=v.costCentre;syncSSLabel(el("costCentre"));\n' +
  '  setExpenseType(v.isTransport?"transport":"regular");\n' +
  '  if(v.isTransport){\n' +
  '    el("vehicleNo").value=v.vehicleNo;syncSSLabel(el("vehicleNo"));\n' +
  '    el("vendorsList").innerHTML="";vendorCount=0;\n' +
  '    (v.vendors||[]).forEach(function(vn){\n' +
  '      var row=addVendorRow();\n' +
  '      row.querySelector(".vnd-name").value=vn.name;syncSSLabel(row.querySelector(".vnd-name"));\n' +
  '      row.querySelector(".vnd-amt").value=vn.amount;\n' +
  '    });\n' +
  '    el("voucherReturnParcel").checked=!!v.returnParcel;\n' +
  '  }else{\n' +
  '    el("ledger").value=v.expenseType;syncSSLabel(el("ledger"));updateVehicleRequirement();\n' +
  '    el("regularAmount").value=v.amount;\n' +
  '    el("regularDescription").value=v.description||"";\n' +
  '    lsReset();\n' +
  '  }\n' +
  '  updateTotal();\n' +
  '  renderExistingFileChips();\n' +
  '  el("fileList").innerHTML="";\n' +
  '  el("confirmSubmit").checked=false;\n' +
  '  el("submitBtn").textContent="Save Changes";\n' +
  '  el("submissionPageSubtitle").textContent="Editing Voucher "+v.voucherId;\n' +
  '  el("cancelEditRow").style.display="";\n' +
  '  showPage("submissionPage");\n' +
  '}\n' +

  'var scopedQueryEditActive=false,queryFieldScope=null,queryTargetLineIndexes=[];\n' +
  // REVISED (25 Aug 2026): the fieldScope strings handled below now match
  // QUERY_CATEGORIES' real keys verbatim (Config.gs) \u2014
  // actualExpenseDate/submittedBy/vehicleNo/costCentre/ledgerOrVendor/
  // amount/description/billFiles/full. The previous branch set
  // (notesFiles/costCentre/amount/vendorLines/full) only coincidentally
  // matched 2 of the 9 real server values (costCentre, amount) plus
  // \'full\' \u2014 for the other 6 query categories (Actual Expense Date,
  // Submitted By, Vehicle No., Ledger/Vendor, Description, Bill Files)
  // NOTHING in this function ever matched, so every field stayed
  // disabled from the top-of-function lockdown with no branch to
  // re-enable the one field the query was actually about \u2014 the
  // submitter could not respond to those 6 query types at all. The old
  // \'costCentre\' branch also incorrectly unlocked the Ledger field on a
  // Regular voucher, which the server has never allowed (that category
  // only ever writes Cost Centre \u2014 Vouchers.gs\'s costCentre branch),
  // so a Regular submitter could edit Ledger client-side and then have
  // the save rejected server-side with \'Only Cost Centre can be
  // changed\'. Both are fixed here. Also newly gated: the bill-upload
  // section (previously never disabled by this function at all, so a
  // submitter could attach new files while responding to e.g. an Amount
  // query \u2014 the server silently drops them, since applyFiles() in
  // Vouchers.gs only runs for fieldScope===\'billFiles\', so the files
  // looked attached in the UI but were never saved).\n' +
  'function applyQueryFieldScopeGating(fieldScope,targetLineIndexes,isTransport){\n' +
  '  var allowSet={};(targetLineIndexes||[]).forEach(function(i){allowSet[i]=true;});\n' +
  '  el("voucherDate").disabled=true;\n' +
  // Actual Expense Date follows the SAME gating voucherDate used to have
  // pre-backdating-build (only unlocked for fieldScope 'full', below) —
  // it's the backdated bill date now, so it belongs in the same category
  // of "narrow query categories never touch this" as before.
  '  el("actualExpenseDate").disabled=true;\n' +
  '  el("addVendorBtn").style.display="none";\n' +
  '  setSSDisabled(el("submittedBy"),true);\n' +
  '  setSSDisabled(el("costCentre"),true);\n' +
  '  setSSDisabled(el("vehicleNo"),true);\n' +
  '  setSSDisabled(el("ledger"),true);\n' +
  '  el("regularAmount").disabled=true;\n' +
  '  el("regularDescription").disabled=true;\n' +
  '  el("voucherReturnParcel").disabled=true;\n' +
  '  el("billFiles").disabled=true;\n' +
  '  el("wholeVoucherUploadSection").classList.add("qfs-locked");\n' +
  '  document.querySelectorAll("#vendorsList .vendor-row").forEach(function(row){\n' +
  '    setSSDisabled(row.querySelector(".vnd-name"),true);\n' +
  '    row.querySelector(".vnd-amt").disabled=true;\n' +
  '    var rb=row.querySelector("[data-remove-vendor]");if(rb)rb.style.display="none";\n' +
  '  });\n' +
  '  if(fieldScope==="description"){\n' +
  '    el("regularDescription").disabled=false;\n' +
  '  }else if(fieldScope==="actualExpenseDate"){\n' +
  '    el("actualExpenseDate").disabled=false;\n' +
  '  }else if(fieldScope==="submittedBy"){\n' +
  '    setSSDisabled(el("submittedBy"),false);\n' +
  '  }else if(fieldScope==="vehicleNo"){\n' +
  '    setSSDisabled(el("vehicleNo"),false);\n' +
  '  }else if(fieldScope==="costCentre"){\n' +
  '    setSSDisabled(el("costCentre"),false);\n' +
  '  }else if(fieldScope==="billFiles"){\n' +
  '    el("billFiles").disabled=false;\n' +
  '    el("wholeVoucherUploadSection").classList.remove("qfs-locked");\n' +
  '  }else if(fieldScope==="ledgerOrVendor"){\n' +
  '    if(!isTransport){setSSDisabled(el("ledger"),false);}\n' +
  '    else{\n' +
  '      document.querySelectorAll("#vendorsList .vendor-row").forEach(function(row,idx){\n' +
  '        if(allowSet[idx])setSSDisabled(row.querySelector(".vnd-name"),false);\n' +
  '      });\n' +
  '    }\n' +
  '  }else if(fieldScope==="amount"){\n' +
  '    if(!isTransport){el("regularAmount").disabled=false;}\n' +
  '    else{\n' +
  '      document.querySelectorAll("#vendorsList .vendor-row").forEach(function(row,idx){\n' +
  '        if(allowSet[idx])row.querySelector(".vnd-amt").disabled=false;\n' +
  '      });\n' +
  '    }\n' +
  '  }else if(fieldScope==="full"){\n' +
  '    el("actualExpenseDate").disabled=false;\n' +
  '    setSSDisabled(el("submittedBy"),false);\n' +
  '    setSSDisabled(el("costCentre"),false);\n' +
  '    setSSDisabled(el("vehicleNo"),false);\n' +
  '    setSSDisabled(el("ledger"),false);\n' +
  '    el("regularAmount").disabled=false;\n' +
  '    el("regularDescription").disabled=false;\n' +
  '    el("voucherReturnParcel").disabled=false;\n' +
  '    el("billFiles").disabled=false;\n' +
  '    el("wholeVoucherUploadSection").classList.remove("qfs-locked");\n' +
  '    document.querySelectorAll("#vendorsList .vendor-row").forEach(function(row){\n' +
  '      setSSDisabled(row.querySelector(".vnd-name"),false);\n' +
  '      row.querySelector(".vnd-amt").disabled=false;\n' +
  '      var rb=row.querySelector("[data-remove-vendor]");if(rb)rb.style.display="";\n' +
  '    });\n' +
  '    el("addVendorBtn").style.display="";\n' +
  '  }\n' +
  '}\n' +
  'function openScopedQueryEditForm(voucherId){\n' +
  '  el("myVouchersAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(qr){\n' +
  '      if(!qr||!qr.success){showAlert("myVouchersAlert","error",(qr&&qr.error)||"Failed to load query.");return;}\n' +
  '      google.script.run\n' +
  '        .withSuccessHandler(function(r){\n' +
  '          if(!r||!r.success){showAlert("myVouchersAlert","error",(r&&r.error)||"Failed to load voucher.");return;}\n' +
  '          fetchFormMetadata(function(){\n' +
  '            enterEditMode(r);\n' +
  '            respondingToQueryVoucherId=voucherId;\n' +
  '            scopedQueryEditActive=true;\n' +
  '            el("submitBtn").textContent="Save Changes & Respond";\n' +
  '            el("submissionPageSubtitle").textContent="Editing Voucher "+voucherId+" \u2014 Responding to Query";\n' +
  '            el("queryResponseSection").classList.remove("hidden");\n' +
  '            el("editQueryBox").innerHTML="<strong>"+esc(qr.queryType)+"</strong> \u2014 raised by "+esc(qr.raisedBy)+" on "+esc(qr.raisedDate)+"<br>"+esc(qr.queryDetails)+\'<br><small style="color:#454B6B;">Only fields related to this query can be changed.</small>\';\n' +
  '            queryFieldScope=qr.fieldScope;\n' +
  '            queryTargetLineIndexes=(qr.targetLines||[]).map(function(t){return t.lineIndex;});\n' +
  '            applyQueryFieldScopeGating(qr.fieldScope,queryTargetLineIndexes,r.isTransport);\n' +
  '          });\n' +
  '        })\n' +
  '        .withFailureHandler(function(err){showAlert("myVouchersAlert","error","Server error: "+err);})\n' +
  '        .getVoucherForEdit(voucherId,appToken);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("myVouchersAlert","error","Server error: "+err);})\n' +
  '    .getOpenQueryForVoucher(voucherId,appToken);\n' +
  '}\n' +

  'function exitEditMode(){\n' +
  // Release the edit lock on the way out — covers Cancel (no save
  // happened) since a successful save already releases it server-side as
  // part of the write itself. Fire-and-forget: a failed release here just
  // falls back to the lock's own timeout, never blocks the UI.
  '  if(editVoucherId)google.script.run.releaseVoucherEditLockRpc(editVoucherId,appToken);\n' +
  '  editVoucherId=null;existingBillFiles=[];removedBillFileUrls=[];respondingToQueryVoucherId=null;\n' +
  '  scopedQueryEditActive=false;queryFieldScope=null;queryTargetLineIndexes=[];\n' +
  // FIXED (bugfix round 2, #7): applyQueryFieldScopeGating directly sets
  // .disabled on real DOM elements (submittedBy, costCentre, vendor rows,
  // etc.), and NOTHING was ever undoing that once the scoped-edit session
  // ended \u2014 the tracking variables above got cleared, but the actual
  // form fields stayed locked. Since this is a single-page app (all pages
  // are divs in one document, never a real reload), that stale disabled
  // state survived navigating away, submitting/approving the voucher, and
  // even logging out and back in \u2014 exactly the reported symptom. The
  // \'full\' branch of applyQueryFieldScopeGating already knows how to
  // re-enable everything it might have disabled, so reuse it here as the
  // unconditional reset \u2014 every exit from edit/query-response mode now
  // always returns the form to fully open, regardless of which scope (if
  // any) was active going in.\n' +
  '  applyQueryFieldScopeGating("full",[],true);\n' +
  '  el("voucherNo").disabled=false;\n' +
  '  el("existingFileListWrap").classList.add("hidden");el("existingFileList").innerHTML="";\n' +
  '  el("submitBtn").textContent="Submit Voucher";\n' +
  '  el("submissionPageSubtitle").textContent="Regular or transport expense, with bills attached";\n' +
  '  el("cancelEditRow").style.display="none";\n' +
  '  el("queryResponseSection").classList.add("hidden");el("editQueryResponse").value="";\n' +
  '}\n' +

  // Decides how "Respond to Query" behaves. Two cases now (bugfix round):
  //  - Rejected: nothing left in the approval chain to protect, full open
  //    edit is safe \u2014 openEditVoucherForQueryResponse.
  //  - Pending L1 / Pending Accounts / Pending L2 with an open query:
  //    field access is gated by the query's category, at EVERY stage a
  //    query can be raised \u2014 openScopedQueryEditForm. CHANGED: Pending
  //    L1 moved from the full-edit case into this one \u2014 it used to fall
  //    through to the unrestricted full edit, which was the actual cause
  //    of query-category scoping appearing not to apply whenever L1 (the
  //    earliest, most common stage) raised the query. See
  //    QUERY_EDIT_STATUSES, Config.gs.
  //  - Anything else (e.g. a query on an Approved voucher): no field
  //    edit at all, just the plain text+file response.
  'function openRespondToQueryFlow(voucherId){\n' +
  '  var v=_myVouchers.find(function(x){return x.voucherId===voucherId;});\n' +
  '  var editable=v&&(v.status==="Rejected");\n' +
  '  var scopedEditable=v&&(v.status==="Pending L1"||v.status==="Pending Accounts"||v.status==="Pending L2");\n' +
  '  if(editable)openEditVoucherForQueryResponse(voucherId);\n' +
  '  else if(scopedEditable)openScopedQueryEditForm(voucherId);\n' +
  '  else openRespondQueryModal(voucherId);\n' +
  '}\n' +

  'function openEditVoucherForQueryResponse(voucherId){\n' +
  '  el("myVouchersAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("myVouchersAlert","error",(r&&r.error)||"Failed to load voucher.");return;}\n' +
  '      fetchFormMetadata(function(){\n' +
  '        enterEditMode(r);\n' +
  '        respondingToQueryVoucherId=voucherId;\n' +
  '        el("submitBtn").textContent="Save Changes & Respond";\n' +
  '        el("submissionPageSubtitle").textContent="Editing Voucher "+voucherId+" \u2014 Responding to Query";\n' +
  '        el("queryResponseSection").classList.remove("hidden");\n' +
  '        el("editQueryBox").textContent="Loading query...";\n' +
  '        google.script.run\n' +
  '          .withSuccessHandler(function(qr){\n' +
  '            if(!qr||!qr.success){el("editQueryBox").textContent="Could not load the query text.";return;}\n' +
  '            el("editQueryBox").innerHTML="<strong>"+esc(qr.queryType)+"</strong> \u2014 raised by "+esc(qr.raisedBy)+" on "+esc(qr.raisedDate)+"<br>"+esc(qr.queryDetails);\n' +
  '          })\n' +
  '          .withFailureHandler(function(){el("editQueryBox").textContent="Could not load the query text.";})\n' +
  '          .getOpenQueryForVoucher(voucherId,appToken);\n' +
  '      });\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("myVouchersAlert","error","Server error: "+err);})\n' +
  '    .getVoucherForEdit(voucherId,appToken);\n' +
  '}\n' +

  'function renderExistingFileChips(){\n' +
  '  var wrap=el("existingFileListWrap"),c=el("existingFileList");\n' +
  // CHANGED (bugfix round 2, #2): bill files are append-only \u2014 existing
  // bills are shown for reference/download only, with no remove control.
  // removedBillFileUrls stays declared (still sent as [] on every submit
  // call, harmless) but is never pushed to anymore; the server also now
  // ignores it regardless (resubmitVoucherCoreWriteOnly, Vouchers.gs).\n' +
  '  c.innerHTML="";\n' +
  '  if(existingBillFiles.length===0){wrap.classList.add("hidden");return;}\n' +
  '  wrap.classList.remove("hidden");\n' +
  '  existingBillFiles.forEach(function(url,i){\n' +
  '    var chip=document.createElement("span");chip.className="file-chip";\n' +
  '    chip.innerHTML=\'<a href="\'+encodeURI(url)+\'" target="_blank" style="color:inherit;text-decoration:underline;">&#x1F4C4; Bill \'+(i+1)+\'</a>\';\n' +
  '    c.appendChild(chip);\n' +
  '  });\n' +
  '}\n' +

  'function goToNewVoucher(){\n' +
  '  exitEditMode();\n' +
  // FIXED (bugfix round 2, #7 continued): previously left every field VALUE
  // (not just the disabled state fixed above) exactly as the last edited
  // voucher had it — going straight from responding to a query on one
  // voucher to "+ Submit New Voucher" could carry that voucher\'s
  // submittedBy/cost centre/vendor rows into the new form. clearSubmissionFormFields
  // (shared with resetForm, below) is now run here too.\n' +
  '  clearSubmissionFormFields();\n' +
  '  loadFormData();\n' +
  '}\n' +

  'function cancelEdit(){\n' +
  '  exitEditMode();\n' +
  '  resetForm();\n' +
  '  loadMyVouchers();\n' +
  '}\n' +

  // ==========================================================================
  // RESPOND TO QUERY (Day 3)
  // ==========================================================================
  'function openRespondQueryModal(voucherId){\n' +
  '  currentRqVoucherId=voucherId;\n' +
  '  rqSelectedFiles=[];\n' +
  '  el("rqVid").textContent=voucherId;\n' +
  '  el("rqAlert").className="alert";\n' +
  '  el("rqResponse").value="";\n' +
  '  el("rqFiles").value="";el("rqFileList").innerHTML="";\n' +
  '  el("rqQueryBox").textContent="Loading...";\n' +
  '  el("respondQueryModal").classList.add("show");\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){el("rqQueryBox").textContent="";setInlineAlert("rqAlert","error",(r&&r.error)||"Failed to load query.");return;}\n' +
  '      el("rqQueryBox").innerHTML="<strong>"+esc(r.queryType)+"</strong> \u2014 raised by "+esc(r.raisedBy)+" on "+esc(r.raisedDate)+"<br>"+esc(r.queryDetails);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){el("rqQueryBox").textContent="";setInlineAlert("rqAlert","error","Server error: "+err);})\n' +
  '    .getOpenQueryForVoucher(voucherId,appToken);\n' +
  '}\n' +

  'function submitQueryResponse(){\n' +
  '  var response=el("rqResponse").value.trim();\n' +
  '  if(!response){showAlert("rqAlert","error","Please enter a response.");return;}\n' +
  '  var btn=el("confirmRqBtn");btn.disabled=true;\n' +
  '  function doRespond(files){\n' +
  '    setBtnLoading(btn,"Sending...");\n' +
  '    google.script.run\n' +
  '      .withSuccessHandler(function(r){\n' +
  '        btn.disabled=false;clearBtnLoading(btn,"Send Response");\n' +
  '        if(!r||!r.success){showAlert("rqAlert","error",(r&&r.error)||"Failed to send response.");return;}\n' +
  '        closeModal("respondQueryModal");\n' +
  '        showAlert("myVouchersAlert","success",r.message);\n' +
  '        fetchMyVouchers();\n' +
  '      })\n' +
  '      .withFailureHandler(function(err){btn.disabled=false;clearBtnLoading(btn,"Send Response");showAlert("rqAlert","error","Server error: "+err);})\n' +
  '      .respondToQuery(currentRqVoucherId,response,JSON.stringify(files),appToken);\n' +
  '  }\n' +
  '  if(!rqSelectedFiles||rqSelectedFiles.length===0){doRespond([]);}\n' +
  '  else{setBtnLoading(btn,"Reading files...");compressImageFiles(rqSelectedFiles).then(function(compressed){readFilesAsBase64(compressed,doRespond);});}\n' +
  '}\n' +

  // ==========================================================================
  // LEDGER SUGGESTION (v4) — suggest-and-confirm. As the submitter types the
  // Description, the server (suggestLedger, Ledger Suggest.gs) proposes up to three
  // ledgers; tapping one fills the Ledger box exactly as picking it by hand would
  // (same change event, so the Vehicle No. rules run as usual). Nothing is ever
  // auto-selected, and every failure just hides the box — submitting is unaffected.
  // ==========================================================================
  'var _lsSeq=0,_lsTimer=null,_lsState=null,_lsClicked="",_lsCache={};\n' +
  'function lsHide(){var b=el("lsBox");if(b)b.classList.add("hidden");}\n' +
  'function lsReset(){clearTimeout(_lsTimer);_lsSeq++;_lsState=null;_lsClicked="";_lsCache={};el("lsChips").innerHTML="";el("lsNote").textContent="";lsHide();}\n' +
  'function lsMarkSelected(){var cur=el("ledger").value,cs=el("lsChips").children;for(var i=0;i<cs.length;i++){cs[i].classList.toggle("on",cs[i].getAttribute("data-ledger")===cur);}}\n' +
  'function lsPick(ledger){\n' +
  '  var sel=el("ledger");if(sel.disabled)return;\n' +
  '  sel.value=ledger;if(sel.value!==ledger)return;\n' +
  '  syncSSLabel(sel);sel.dispatchEvent(new Event("change"));\n' +
  '  _lsClicked=ledger;lsMarkSelected();\n' +
  '}\n' +
  'function lsRender(r){\n' +
  '  var chips=el("lsChips"),note=el("lsNote"),title=el("lsTitle"),sug=r.suggestions||[];\n' +
  '  chips.innerHTML="";note.textContent="";\n' +
  '  _lsState={top:sug.length?sug[0].ledger:"",tier:r.tier||"none",shown:sug.map(function(x){return x.ledger;})};\n' +
  '  if(el("ledger").disabled||(!sug.length&&!r.hint)){lsHide();return;}\n' +
  '  title.textContent=r.tier==="high"?"Suggested ledger":(r.tier==="medium"?"Which of these fits best?":"Not sure - best guesses:");\n' +
  '  sug.forEach(function(x,i){\n' +
  '    var b=document.createElement("button");b.type="button";\n' +
  '    b.className="ls-chip"+(i===0&&r.tier==="high"?" top":"");\n' +
  '    b.setAttribute("data-ledger",x.ledger);b.title=x.why||"";\n' +
  '    b.appendChild(document.createTextNode(x.ledger));\n' +
  '    if(x.needsVehicle){var sm=document.createElement("small");sm.textContent="  (you will pick the vehicle)";b.appendChild(sm);}\n' +
  '    b.addEventListener("click",function(){lsPick(x.ledger);});\n' +
  '    chips.appendChild(b);\n' +
  '  });\n' +
  '  var msg=[];\n' +
  '  if(r.hint==="transport")msg.push("Hired vehicle, transporter bill or return parcel? Use the Transport Expense button at the top instead.");\n' +
  '  if(r.tier==="low"&&sug.length)msg.push("Still not sure? Ask the Accounts team before you submit.");\n' +
  '  note.textContent=msg.join(" ");\n' +
  '  el("lsBox").classList.remove("hidden");lsMarkSelected();\n' +
  '}\n' +
  'function lsFetch(t){\n' +
  '  if(_lsCache[t]){lsRender(_lsCache[t]);return;}\n' +
  '  var seq=++_lsSeq;\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){if(seq!==_lsSeq)return;if(!r||!r.success){lsHide();return;}_lsCache[t]=r;lsRender(r);})\n' +
  '    .withFailureHandler(function(){if(seq===_lsSeq)lsHide();})\n' +
  '    .suggestLedger(appToken,t);\n' +
  '}\n' +
  'function lsOnDescInput(){\n' +
  '  clearTimeout(_lsTimer);\n' +
  '  var t=el("regularDescription").value.trim();\n' +
  '  if(t.length<6){_lsSeq++;lsHide();return;}\n' +
  '  _lsTimer=setTimeout(function(){lsFetch(t);},700);\n' +
  '}\n' +
  'function setExpenseType(type){\n' +
  '  var t=(type==="transport");\n' +
  '  el("typeRegular").classList.toggle("active",!t);\n' +
  '  el("typeTransport").classList.toggle("active",t);\n' +
  '  el("regularSection").classList.toggle("hidden",t);\n' +
  '  el("transportSection").classList.toggle("hidden",!t);\n' +
  '  updateVehicleRequirement();\n' +
  '  if(t&&el("vendorsList").children.length===0)addVendorRow();\n' +
  '  updateTotal();\n' +
  '}\n' +

  // Vehicle No. is compulsory whenever it is a Transport voucher OR a
  // Regular voucher on one of the three vehicle-linked ledgers (per
  // explicit instruction, revised) — and BLOCKED (disabled + cleared) for
  // every other Regular ledger, since a vehicle has no meaning there.
  // Re-run live on every ledger change (no lag) via the "change" listener
  // wired below, on expense-type toggle (setExpenseType above), and once
  // more right after edit mode programmatically sets the ledger value
  // (enterEditMode) \u2014 the same three places the field's value can change.
  'var VEHICLE_REQUIRED_LEDGERS=["Vehicle Operating - Jakat/Toll","Vehicle Fastag","Vehicle Operating - Petrol"];\n' +
  'function isVehicleLedgerSelected(){\n' +
  '  return !el("typeTransport").classList.contains("active")&&VEHICLE_REQUIRED_LEDGERS.indexOf(el("ledger").value)!==-1;\n' +
  '}\n' +
  'function updateVehicleRequirement(){\n' +
  '  var isT=el("typeTransport").classList.contains("active");\n' +
  '  var required=isT||isVehicleLedgerSelected();\n' +
  '  var blocked=!isT&&!isVehicleLedgerSelected();\n' +
  '  el("vehicleReqStar").style.display=required?"":"none";\n' +
  '  el("vehicleOptHint").style.display=blocked?"":"none";\n' +
  '  if(blocked){el("vehicleNo").value="";syncSSLabel(el("vehicleNo"));}\n' +
  '  setSSDisabled(el("vehicleNo"),blocked);\n' +
  '}\n' +

  // REVISED (Day 5): Option B rolled back per explicit instruction — a
  // vendor row is back to just name + amount. Bills for a transport
  // voucher now go through the SAME whole-voucher upload zone Regular
  // always used (wholeVoucherUploadSection, no longer hidden for
  // Transport) — one combined PDF/photo set covering every bill on the
  // voucher, not a required file per vendor line. The same vendor can
  // still be added on 2+ separate rows (2 separate bills, 2 amounts) —
  // Tally export now clubs those back together when generating entries.
  'function addVendorRow(){\n' +
  '  var list=el("vendorsList"),id="vr"+(++vendorCount);\n' +
  '  var opts=\'<option value="">-- Select vendor --</option>\';\n' +
  '  _vendorList.forEach(function(v){opts+=\'<option value="\'+v.replace(/"/g,"&quot;")+\'">\'+esc(v)+\'</option>\';});\n' +
  '  var div=document.createElement("div");\n' +
  '  div.className="vendor-row";div.id=id;\n' +
  '  div.innerHTML=\'<div class="vendor-row-inner"><div class="form-group"><label>Vendor Name</label><select class="vnd-name">\'+opts+\'</select></div><div class="form-group"><label>Amount (Rs.)</label><input type="number" class="vnd-amt" placeholder="0.00" min="0" step="0.01"></div><button type="button" class="btn btn-remove" data-remove-vendor="\'+id+\'">Remove</button></div>\';\n' +
  '  list.appendChild(div);\n' +
  '  div.querySelector(".vnd-amt").addEventListener("input",updateTotal);\n' +
  '  makeSearchableSelectEl(div.querySelector(".vnd-name"));\n' +
  '  return div;\n' +
  '}\n' +

  'function updateTotal(){\n' +
  '  var total=0,isT=el("typeTransport").classList.contains("active");\n' +
  '  if(isT){\n' +
  '    document.querySelectorAll(".vendor-row").forEach(function(row){\n' +
  '      total+=parseFloat(row.querySelector(".vnd-amt").value)||0;\n' +
  '    });\n' +
  '  }\n' +
  '  else{total=parseFloat(el("regularAmount").value)||0;}\n' +
  '  el("totalDisplay").textContent="Rs. "+total.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});\n' +
  '  el("stampWarning").classList.toggle("show",total>5000);\n' +
  '}\n' +

  'function renderFileChips(){\n' +
  '  var c=el("fileList");c.innerHTML="";\n' +
  '  selectedFiles.forEach(function(f,i){\n' +
  '    var chip=document.createElement("span");chip.className="file-chip";\n' +
  '    var sizeLabel=f.size?" ("+(f.size/1024/1024).toFixed(1)+"MB)":"";\n' +
  '    chip.innerHTML="&#x1F4C4; "+esc(f.name)+esc(sizeLabel)+" <span class=\'rm\' data-remove-file=\'"+i+"\'>&#x2715;</span>";\n' +
  '    c.appendChild(chip);\n' +
  '  });\n' +
  '}\n' +

  // Client-side image compression before upload, so the app can accept up\n' +
  // to formMaxFiles bills without the base64 payload sent through\n' +
  // google.script.run (and the synchronous Drive writes that follow it in\n' +
  // one execution) growing unmanageably large. Downscales to at most\n' +
  // IMG_MAX_DIMENSION px on the longest side and re-encodes as JPEG at\n' +
  // IMG_JPEG_QUALITY — enough to keep a phone-camera bill legible while\n' +
  // typically cutting file size by 70-90%. PDFs and HEIC/HEIF (which\n' +
  // <canvas> generally cannot decode) pass through untouched. If\n' +
  // compression ever produces a LARGER file than the original (rare, e.g.\n' +
  // an already-compact image), the original is kept.\n' +
  'var IMG_MAX_DIMENSION=1800,IMG_JPEG_QUALITY=0.75;\n' +
  'function compressImageFile(file){\n' +
  '  return new Promise(function(resolve){\n' +
  '    if(!file.type||file.type.indexOf("image/")!==0||file.type==="image/heic"||file.type==="image/heif"){resolve(file);return;}\n' +
  '    var url=URL.createObjectURL(file),img=new Image();\n' +
  '    img.onload=function(){\n' +
  '      URL.revokeObjectURL(url);\n' +
  '      var scale=Math.min(1,IMG_MAX_DIMENSION/Math.max(img.width,img.height));\n' +
  '      var w=Math.round(img.width*scale),h=Math.round(img.height*scale);\n' +
  '      var canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;\n' +
  '      canvas.getContext("2d").drawImage(img,0,0,w,h);\n' +
  '      canvas.toBlob(function(blob){\n' +
  '        if(!blob||blob.size>=file.size){resolve(file);return;}\n' +
  '        var newName=file.name.replace(/\\.(png|heic|heif|bmp|webp|jpeg)$/i,".jpg");\n' +
  '        resolve(new File([blob],newName,{type:"image/jpeg"}));\n' +
  '      },"image/jpeg",IMG_JPEG_QUALITY);\n' +
  '    };\n' +
  '    img.onerror=function(){URL.revokeObjectURL(url);resolve(file);};\n' +
  '    img.src=url;\n' +
  '  });\n' +
  '}\n' +
  'function compressImageFiles(files){return Promise.all(files.map(compressImageFile));}\n' +

  'function readFilesAsBase64(files,callback){\n' +
  '  if(!files||files.length===0){callback([]);return;}\n' +
  '  var results=new Array(files.length),done=0;\n' +
  '  files.forEach(function(file,idx){\n' +
  '    var reader=new FileReader();\n' +
  '    reader.onload=function(e){' +
  '      var b64=e.target.result;' +
  '      var commaIdx=b64.indexOf(",");' +
  '      if(commaIdx<0){done++;if(done===files.length)callback(results.filter(Boolean));return;}\n' +
  '      results[idx]={name:file.name,mimeType:file.type||"application/octet-stream",data:b64.substring(commaIdx+1)};' +
  '      done++;if(done===files.length)callback(results);\n' +
  '    };\n' +
  '    reader.onerror=function(){done++;if(done===files.length)callback(results.filter(Boolean));};' +
  '    reader.readAsDataURL(file);\n' +
  '  });\n' +
  '}\n' +

  // New Vendor Request — reuses readFilesAsBase64 (above) with a
  // single-element array, same pattern every other file upload in this
  // app already uses, just without image compression (a vendor bill
  // photo doesn't need the same size discipline as a 25-file voucher
  // upload batch).
  'function openRequestVendorModal(){\n' +
  '  el("requestVendorName").value="";el("requestVendorFile").value="";el("requestVendorNotes").value="";\n' +
  '  el("requestVendorAlert").className="alert";\n' +
  '  el("requestNewVendorModal").classList.add("show");\n' +
  '}\n' +

  'function confirmRequestVendor(){\n' +
  '  var name=el("requestVendorName").value.trim(),fileInput=el("requestVendorFile"),notes=el("requestVendorNotes").value.trim();\n' +
  '  if(!name){setInlineAlert("requestVendorAlert","error","Vendor name is required.");return;}\n' +
  '  if(!fileInput.files||fileInput.files.length===0){setInlineAlert("requestVendorAlert","error","Please attach the vendor\\u2019s bill.");return;}\n' +
  '  var btn=el("confirmRequestVendorBtn");btn.disabled=true;btn.textContent="Sending...";\n' +
  '  readFilesAsBase64([fileInput.files[0]],function(files){\n' +
  '    if(files.length===0){btn.disabled=false;btn.textContent="Send Request";setInlineAlert("requestVendorAlert","error","Could not read the file \\u2014 try a different one.");return;}\n' +
  '    google.script.run\n' +
  '      .withSuccessHandler(function(r){\n' +
  '        btn.disabled=false;btn.textContent="Send Request";\n' +
  '        if(!r||!r.success){setInlineAlert("requestVendorAlert","error",(r&&r.error)||"Failed to send request.");return;}\n' +
  '        closeModal("requestNewVendorModal");\n' +
  '        showAlert("submissionAlert","success",r.message||"Vendor request sent.");\n' +
  '      })\n' +
  '      .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Send Request";setInlineAlert("requestVendorAlert","error","Server error: "+err);})\n' +
  '      .requestNewVendor(name,JSON.stringify(files[0]),notes,appToken);\n' +
  '  });\n' +
  '}\n' +

  // New Employee Request — same pattern as confirmRequestVendor above,
  // just no file to read first: the RPC call fires directly.
  'function openRequestEmployeeModal(){\n' +
  '  el("requestEmployeeName").value="";el("requestEmployeeNotes").value="";\n' +
  '  el("requestEmployeeAlert").className="alert";\n' +
  '  el("requestNewEmployeeModal").classList.add("show");\n' +
  '}\n' +
  'function confirmRequestEmployee(){\n' +
  '  var name=el("requestEmployeeName").value.trim(),notes=el("requestEmployeeNotes").value.trim();\n' +
  '  if(!name){setInlineAlert("requestEmployeeAlert","error","Employee name is required.");return;}\n' +
  '  var btn=el("confirmRequestEmployeeBtn");btn.disabled=true;btn.textContent="Sending...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Send Request";\n' +
  '      if(!r||!r.success){setInlineAlert("requestEmployeeAlert","error",(r&&r.error)||"Failed to send request.");return;}\n' +
  '      closeModal("requestNewEmployeeModal");\n' +
  '      showAlert("submissionAlert","success",r.message||"Employee request sent.");\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Send Request";setInlineAlert("requestEmployeeAlert","error","Server error: "+err);})\n' +
  '    .requestNewEmployee(name,notes,appToken);\n' +
  '}\n' +

  // Live duplicate check as the user leaves the Voucher No. field — purely
  // informational, the server-side check at submit time is still what
  // actually enforces uniqueness.
  'function checkVoucherNoLive(){\n' +
  '  var vno=el("voucherNo").value.trim(),hint=el("voucherNoHint");\n' +
  '  hint.style.display="none";\n' +
  '  if(!vno)return;\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(r&&r.success&&r.exists)hint.style.display="block";\n' +
  '    })\n' +
  '    .withFailureHandler(function(){})\n' +
  '    .checkVoucherIdExists(vno,appToken);\n' +
  '}\n' +

  'function submitVoucher(){\n' +
  '  el("submissionAlert").className="alert";\n' +
  '  if(!el("confirmSubmit").checked){showAlert("submissionAlert","error","Please confirm that all details are correct.");return;}\n' +
  '  var isEdit=!!editVoucherId;\n' +
  '  var isQueryResponse=!!respondingToQueryVoucherId;\n' +
  '  var queryResponseText=el("editQueryResponse").value.trim();\n' +
  '  if(isQueryResponse&&!queryResponseText){showAlert("submissionAlert","error","Please enter a response to the query.");return;}\n' +
  '  var isT=el("typeTransport").classList.contains("active");\n' +
  '  var vno=el("voucherNo").value.trim(),sub=el("submittedBy").value,cc=el("costCentre").value,veh=el("vehicleNo").value,vdt=el("voucherDate").value,aedt=el("actualExpenseDate").value;\n' +
  '  if(!vno){showAlert("submissionAlert","error","Please enter the Voucher Number.");return;}\n' +
  '  if(!sub){showAlert("submissionAlert","error","Please select Submitted By.");return;}\n' +
  '  if(!cc){showAlert("submissionAlert","error","Please select Cost Centre.");return;}\n' +
  '  if(!vdt){showAlert("submissionAlert","error","Please select a Date.");return;}\n' +
  '  if(!aedt){showAlert("submissionAlert","error","Please select the Actual Expense Date (the date on the bill).");return;}\n' +
  // Client-side pre-check only, purely for fast feedback \u2014
  // isFutureCalendarDate (Vouchers.gs) is the real, authoritative check.
  // Compares against the input's own max attribute (real "today", set in
  // loadFormData/enterEditMode) rather than vdt \u2014 vdt is the voucher's
  // ORIGINAL submission date during an edit, which can be in the past,
  // and comparing against that would wrongly block moving the bill date
  // forward toward actual today.
  '  if(el("actualExpenseDate").max&&aedt>el("actualExpenseDate").max){el("actualExpenseDateHint").style.display="";showAlert("submissionAlert","error","Actual Expense Date cannot be in the future.");return;}\n' +
  '  el("actualExpenseDateHint").style.display="none";\n' +
  '  if(isT&&!veh){showAlert("submissionAlert","error","Vehicle No. is required for Transport vouchers.");return;}\n' +
  // FIXED: previously sent new Date(vdt).toLocaleDateString("en-IN")
  // ("1/8/2026" for 1 Aug). The server re-parsed that with new Date(),
  // which reads unlabeled slash-dates as US M/d/yyyy — turning 1 Aug
  // into 8 Jan. vdt is already the native <input type="date"> value
  // (yyyy-mm-dd, ISO, unambiguous) — send it as-is and let the server
  // parse it with parseClientDateString (Sheet Utils.gs).\n' +
  '  var fd={expenseType:isT?"transport":"regular",voucherNo:vno,submittedBy:sub,costCentre:cc,vehicleNo:veh,date:vdt,actualExpenseDate:aedt};\n' +
  // REVISED (Day 5): Option B rolled back — the whole-voucher file check
  // now applies uniformly to BOTH Regular and Transport (existing bill
  // files + newly-selected selectedFiles, same as Regular always worked).
  // Vendor rows themselves no longer carry per-line file state.
  '  var remainingExistingCount=isEdit?existingBillFiles.filter(function(u){return removedBillFileUrls.indexOf(u)<0;}).length:0;\n' +
  '  if(remainingExistingCount+(selectedFiles?selectedFiles.length:0)===0){showAlert("submissionAlert","error","At least one bill file must be uploaded.");return;}\n' +
  '  if(!isT){\n' +
  '    var lg=el("ledger").value,am=parseFloat(el("regularAmount").value)||0,desc=el("regularDescription").value.trim();\n' +
  '    if(!lg){showAlert("submissionAlert","error","Please select a Ledger.");return;}\n' +
  '    if(am<=0){showAlert("submissionAlert","error","Please enter a valid Amount.");return;}\n' +
  '    if(!desc){showAlert("submissionAlert","error","Please enter a Description.");return;}\n' +
  // Vehicle-linked Regular ledgers (per explicit instruction, revised):
  // Vehicle No. selection is compulsory for these three ledgers and
  // blocked (disabled, cleared) for every other Regular ledger by
  // updateVehicleRequirement above — client-side fast-feedback check only;
  // validateVoucherCoreFields (Vouchers.gs) is the real, authoritative
  // check this mirrors.
  '    if(VEHICLE_REQUIRED_LEDGERS.indexOf(lg)!==-1&&!veh){showAlert("submissionAlert","error","Select a vehicle for the \\""+lg+"\\" ledger.");return;}\n' +
  '    fd.ledger=lg;fd.amount=am;fd.description=desc;\n' +
  '  }else{\n' +
  '    var vendors=[],ok=true;\n' +
  '    document.querySelectorAll(".vendor-row").forEach(function(row){\n' +
  '      var n=row.querySelector(".vnd-name").value,a=parseFloat(row.querySelector(".vnd-amt").value)||0;\n' +
  '      if(!n||a<=0){ok=false;return;}\n' +
  '      vendors.push({name:n,amount:a});\n' +
  '    });\n' +
  '    if(!ok||vendors.length===0){showAlert("submissionAlert","error","All vendors need a name and amount > 0.");return;}\n' +
  '    fd.vendors=vendors;\n' +
  '    fd.amount=vendors.reduce(function(s,v){return s+v.amount;},0);\n' +
  '    fd.returnParcel=el("voucherReturnParcel").checked;\n' +
  '  }\n' +
  '  var btn=el("submitBtn");btn.disabled=true;\n' +
  '  function doSubmit(files){\n' +
  '    setBtnLoading(btn,isEdit?"Saving...":"Submitting...");\n' +
  '    var handler=google.script.run\n' +
  '      .withSuccessHandler(function(r){\n' +
  '        btn.disabled=false;clearBtnLoading(btn,isEdit?"Save Changes":"Submit Voucher");\n' +
  '        if(!r||!r.success){showAlert("submissionAlert","error",(r&&r.error)||(isEdit?"Resubmit failed.":"Submission failed."));return;}\n' +
  '        if(isEdit){\n' +
  '          exitEditMode();\n' +
  '          loadMyVouchers();\n' +
  '          showAlert("myVouchersAlert","success",r.message);\n' +
  '        }else{\n' +
  '          if(!isT&&_lsState){google.script.run.withFailureHandler(function(){}).logLedgerSuggestion(r.voucherId,JSON.stringify({top:_lsState.top,tier:_lsState.tier,shown:_lsState.shown,chosen:fd.ledger,clicked:_lsClicked===fd.ledger}),appToken);}\n' +
  '          showSuccess(r.voucherId,r.batchId,r.fileCount||0,r.failedCount||0,r.failedFiles||[]);\n' +
  '        }\n' +
  '      })\n' +
  '      .withFailureHandler(function(err){btn.disabled=false;clearBtnLoading(btn,isEdit?"Save Changes":"Submit Voucher");showAlert("submissionAlert","error","Server error: "+err);});\n' +
  '    if(isQueryResponse&&scopedQueryEditActive)handler.resubmitVoucherForQueryScope(respondingToQueryVoucherId,JSON.stringify(fd),JSON.stringify(files),JSON.stringify(removedBillFileUrls),queryResponseText,appToken);\n' +
  '    else if(isQueryResponse)handler.resubmitVoucherAndRespondToQuery(respondingToQueryVoucherId,JSON.stringify(fd),JSON.stringify(files),JSON.stringify(removedBillFileUrls),queryResponseText,appToken);\n' +
  '    else if(isEdit)handler.resubmitVoucher(editVoucherId,JSON.stringify(fd),JSON.stringify(files),JSON.stringify(removedBillFileUrls),appToken);\n' +
  '    else handler.saveVoucherSubmission(JSON.stringify(fd),JSON.stringify(files),appToken);\n' +
  '  }\n' +
  // Files are read to base64 and sent in the SAME call as the form data, so
  // the row write and the bill upload either both happen or the user sees
  // one clear error. ONE whole-voucher file path now, for both Regular and
  // Transport — no more per-vendor-row file collection.
  '  if(!selectedFiles||selectedFiles.length===0){doSubmit([]);}\n' +
  '  else{setBtnLoading(btn,"Reading files ("+selectedFiles.length+")...");readFilesAsBase64(selectedFiles,doSubmit);}\n' +
  '}\n' +

  'function showSuccess(vid,bid,cnt,failed,flist){\n' +
  '  el("successVid").textContent=vid;\n' +
  '  el("successBatch").textContent=bid;\n' +
  '  el("successFileNote").textContent=cnt>0?cnt+" bill file(s) uploaded to Google Drive.":"";\n' +
  '  var w=el("successFileWarning");\n' +
  '  if(failed>0){\n' +
  '    w.textContent="⚠ "+failed+" file(s) failed to upload: "+flist.join(", ")+". Voucher is still valid; please re-upload separately if needed.";\n' +
  '    w.style.display="block";\n' +
  '  }else{w.style.display="none";}\n' +
  '  el("formBody").classList.add("hidden");\n' +
  '  el("successBody").classList.remove("hidden");\n' +
  '}\n' +

  'function clearSubmissionFormFields(){\n' +
  '  setDateInputFromLocalDate(el("voucherDate"),new Date());\n' +
  '  el("actualExpenseDate").max=el("voucherDate").value;\n' +
  '  el("actualExpenseDateHint").style.display="none";\n' +
  '  ["submittedBy","vehicleNo","costCentre","ledger"].forEach(function(id){el(id).value="";syncSSLabel(el(id));});\n' +
  '  el("regularAmount").value="";el("regularDescription").value="";\n' +
  '  lsReset();\n' +
  '  el("confirmSubmit").checked=false;\n' +
  '  el("vendorsList").innerHTML="";el("billFiles").value="";el("fileList").innerHTML="";\n' +
  '  el("voucherReturnParcel").checked=false;\n' +
  '  selectedFiles=[];vendorCount=0;\n' +
  '  setExpenseType("regular");updateTotal();\n' +
  '}\n' +

  'function resetForm(){\n' +
  '  exitEditMode();\n' +
  // CHANGED: Voucher Date is now permanently fixed to today (immutable —
  // see backend resubmitVoucherCoreWriteOnly) and the field is disabled,
  // so there is nothing left to preserve there; force it back to today
  // on every reset. Actual Expense Date inherits the old "don't reset"
  // convenience instead — batch-entering several bills from the same
  // backdated date in a row is still the real workflow this serves.
  '  clearSubmissionFormFields();\n' +
  '  el("successBody").classList.add("hidden");\n' +
  '  el("formBody").classList.remove("hidden");\n' +
  '  el("submissionAlert").className="alert";\n' +
  '  google.script.run.withSuccessHandler(function(r){if(r&&r.success)el("voucherNo").value=r.voucherNo;}).fetchNextVoucherNumber(appToken);\n' +
  '}\n' +

  'function loadApprovalDashboard(){\n' +
  '  var lbl={L1:"L1 Approval — Rabale Manager",accounts:"Accounts Approval",L2:"L2 Approval"};\n' +
  '  var stageOnly={L1:"L1 Approval",accounts:"Accounts Approval",L2:"L2 Approval"};\n' +
  '  el("approvalRoleLabel").textContent=(appDesignation&&stageOnly[appRole])?(stageOnly[appRole]+" \\u00b7 "+appDesignation):(lbl[appRole]||"Approval Dashboard");\n' +
  '  var pendingByRole={L1:"Pending L1",accounts:"Pending Accounts",L2:"Pending L2"};\n' +
  '  currentFilter=pendingByRole[appRole]||"all";\n' +
  '  el("rdsCashGivenPanel").classList.toggle("hidden",appRole!=="accounts");\n' +
  '  el("cashWithdrawalPanel").classList.toggle("hidden",appRole!=="accounts");\n' +
  '  el("l2WithdrawalPanel").classList.toggle("hidden",appRole!=="L2");\n' +
  '  showPage("approvalPage");\n' +
  '  fetchVouchers();\n' +
  '  if(appRole==="accounts"){fetchRdsCashGivenStatus();fetchCashWithdrawalStatus();}\n' +
  '  if(appRole==="L2")fetchL2WithdrawalRequests();\n' +
  '}\n' +

  // ==========================================================================
  // LANDING DASHBOARD (#18, design pass) — default post-login page for
  // L1/accounts/L2/admin (see routeToRolePage). Pure read-only overview;
  // "Go to Approval Queue" hands off to the existing approval dashboard.
  // ==========================================================================
  'var _dashData=null;\n' +
  'var DASH_PIE_COLORS=["#2E3192","#B8791E","#5F6684","#C0433F","#5A8FC9","#B79B4B"];\n' +
  'function loadDashboard(){\n' +
  '  var lbl={L1:"L1 overview",accounts:"Accounts overview",L2:"L2 overview",admin:"Admin overview"};\n' +
  '  el("dashboardSubtitle").textContent=lbl[appRole]||"Overview";\n' +
  '  showPage("dashboardPage");\n' +
  '  el("dashboardAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("dashboardAlert","error",(r&&r.error)||"Failed to load dashboard.");return;}\n' +
  '      _dashData=r;\n' +
  '      renderDashboard();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("dashboardAlert","error","Server error: "+err);})\n' +
  '    .getDashboardSummary(appToken);\n' +
  '}\n' +
  'function renderDashboard(){\n' +
  '  var r=_dashData;if(!r)return;\n' +
  '  el("dashStatReady").textContent="Rs. "+r.readyToRelease.amount.toLocaleString("en-IN");\n' +
  '  el("dashStatReadySub").textContent=r.readyToRelease.count+" approved voucher(s)";\n' +
  '  el("dashStatPending").textContent=r.pendingApproval.count;\n' +
  '  el("dashStatQueries").textContent=r.openQueries.count;\n' +
  '  el("dashStatMonth").textContent="Rs. "+r.monthTotal.current.toLocaleString("en-IN");\n' +
  '  el("dashStatMonthSub").textContent="vs Rs. "+r.monthTotal.previous.toLocaleString("en-IN")+" last month";\n' +
  '  renderDashVendors(r.topVendors||[]);\n' +
  '  var sel=el("dashBatchSelect");sel.innerHTML="";\n' +
  '  (r.batchIds||[]).forEach(function(bid){var o=document.createElement("option");o.value=bid;o.textContent=bid;sel.appendChild(o);});\n' +
  '  if((r.batchIds||[]).length>0){sel.value=r.batchIds[0];renderDashPie(r.batchIds[0]);}\n' +
  '  else{el("dashPieWrap").innerHTML=\'<div class="empty-state" style="padding:20px;"><p>No batch data yet.</p></div>\';}\n' +
  '}\n' +
  'function renderDashVendors(vendors){\n' +
  '  var tbody=el("dashVendorsBody"),empty=el("dashVendorsEmpty"),table=el("dashVendorsTable");\n' +
  '  tbody.innerHTML="";\n' +
  '  if(vendors.length===0){table.style.display="none";empty.classList.remove("hidden");return;}\n' +
  '  empty.classList.add("hidden");table.style.display="";\n' +
  '  vendors.forEach(function(v){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    tr.innerHTML="<td>"+esc(v.name)+"</td><td style=\\"text-align:right;font-weight:700;\\">Rs. "+Math.round(v.amount).toLocaleString("en-IN")+"</td>";\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '}\n' +
  'function renderDashPie(batchId){\n' +
  '  var wrap=el("dashPieWrap");\n' +
  '  var slices=(_dashData.batchBreakdown[batchId]||[]).filter(function(s){return s.amount>0;});\n' +
  '  if(slices.length===0){wrap.innerHTML=\'<div class="empty-state" style="padding:20px;"><p>No data for this batch.</p></div>\';return;}\n' +
  '  var total=slices.reduce(function(s,x){return s+x.amount;},0);\n' +
  '  var cx=70,cy=70,r=70,angle=-90;\n' +
  '  var paths="";\n' +
  '  slices.forEach(function(s,i){\n' +
  '    var frac=s.amount/total,sweep=frac*360;\n' +
  '    var x1=cx+r*Math.cos(angle*Math.PI/180),y1=cy+r*Math.sin(angle*Math.PI/180);\n' +
  '    var endAngle=angle+sweep;\n' +
  '    var x2=cx+r*Math.cos(endAngle*Math.PI/180),y2=cy+r*Math.sin(endAngle*Math.PI/180);\n' +
  '    var large=sweep>180?1:0;\n' +
  '    if(slices.length===1){paths+=\'<circle cx="\'+cx+\'" cy="\'+cy+\'" r="\'+r+\'" fill="\'+DASH_PIE_COLORS[0]+\'"/>\';}\n' +
  '    else{paths+=\'<path d="M\'+cx+\' \'+cy+\' L\'+x1+\' \'+y1+\' A\'+r+\' \'+r+\' 0 \'+large+\' 1 \'+x2+\' \'+y2+\' Z" fill="\'+DASH_PIE_COLORS[i%DASH_PIE_COLORS.length]+\'"/>\';}\n' +
  '    angle=endAngle;\n' +
  '  });\n' +
  '  var legend=slices.map(function(s,i){\n' +
  '    return \'<div class="dash-pie-legend-item"><span class="dash-pie-legend-swatch" style="background:\'+DASH_PIE_COLORS[i%DASH_PIE_COLORS.length]+\'"></span>\'+esc(s.type)+\' \\u2014 Rs. \'+Math.round(s.amount).toLocaleString("en-IN")+"</div>";\n' +
  '  }).join("");\n' +
  '  wrap.innerHTML=\'<div class="dash-pie-row"><svg width="140" height="140" viewBox="0 0 140 140">\'+paths+\'</svg><div class="dash-pie-legend">\'+legend+"</div></div>";\n' +
  '}\n' +

  // ==========================================================================
  // RDS CASH GIVEN (Day 7) — accounts-only panel on the Approval Dashboard.
  // ==========================================================================
  'var _rdsCashGivenSelected={};\n' +
  'function fetchRdsCashGivenStatus(){\n' +
  '  el("rdsCashGivenStatusText").textContent="Loading...";\n' +
  '  el("rdsCashGivenAddBtn").disabled=true;\n' +
  '  el("rdsCashGivenAmount").disabled=true;\n' +
  '  _rdsCashGivenSelected={};\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){el("rdsCashGivenStatusText").textContent=(r&&r.error)||"Could not load status.";return;}\n' +
  '      renderRdsCashGivenStatus(r);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){el("rdsCashGivenStatusText").textContent="Server error: "+err;})\n' +
  '    .getRdsCashGivenStatus(appToken);\n' +
  '}\n' +

  'function renderRdsCashGivenStatus(r){\n' +
  '  if(!r.unreleasedCount){\n' +
  '    el("rdsCashGivenStatusText").textContent="No Approved, unreleased vouchers right now \u2014 nothing to release cash against.";\n' +
  '    el("rdsCashGivenBatches").innerHTML="";\n' +
  '    el("rdsCashGivenAddBtn").disabled=true;el("rdsCashGivenAmount").disabled=true;\n' +
  '    updateRdsCashGivenSelectedText();\n' +
  '  }else{\n' +
  '    el("rdsCashGivenStatusText").innerHTML=r.unreleasedCount+" Approved voucher(s) awaiting cash release, totalling <strong style=\'color:#1F5B45;\'>Rs. "+r.unreleasedAmount.toLocaleString("en-IN")+"</strong>. Select which batch(es)/voucher(s) to release cash against.";\n' +
  '    el("rdsCashGivenAmount").disabled=false;\n' +
  '    renderRdsCashGivenBatches(r.unreleasedVouchers||[]);\n' +
  '  }\n' +
  '  var log=el("rdsCashGivenLog");\n' +
  '  if(r.todaysEntries&&r.todaysEntries.length>0){\n' +
  '    var total=r.todaysEntries.reduce(function(s,e){return s+e.amount;},0);\n' +
  '    log.innerHTML="Added today: "+r.todaysEntries.map(function(e){return "Rs. "+e.amount.toLocaleString("en-IN");}).join(" + ")+" = <strong>Rs. "+total.toLocaleString("en-IN")+"</strong> total";\n' +
  '  }else{\n' +
  '    log.textContent="";\n' +
  '  }\n' +
  '}\n' +

  // Batch/voucher checklist (24 Aug 2026 fix) — one collapsible group per
  // Batch ID, a select-all checkbox per batch, and one checkbox per
  // voucher underneath for a single-voucher release within a batch.
  // Nothing here writes anything server-side by itself; it only builds
  // the voucherIds list submitRdsCashGiven sends on Add Cash Given.
  'function renderRdsCashGivenBatches(vouchers){\n' +
  '  var byBatch={};\n' +
  '  vouchers.forEach(function(v){(byBatch[v.batchId]=byBatch[v.batchId]||[]).push(v);});\n' +
  '  var batchIds=Object.keys(byBatch).sort().reverse();\n' +
  '  el("rdsCashGivenBatches").innerHTML=batchIds.map(function(bid,bidx){\n' +
  '    var lines=byBatch[bid];\n' +
  '    var batchTotal=lines.reduce(function(s,l){return s+l.amount;},0);\n' +
  '    var rowsHtml=lines.map(function(v){\n' +
  '      return \'<label style="display:flex;justify-content:space-between;align-items:center;padding:6px 12px 6px 32px;font-size:14px;border-top:1px dashed #ECEEFB;cursor:pointer;">\'+\n' +
  '        \'<span><input type="checkbox" class="rds-cg-voucher-check" data-batch="\'+esc(bid)+\'" data-vid="\'+esc(v.voucherId)+\'" data-amt="\'+v.amount+\'" style="margin-right:8px;"> \'+esc(v.voucherId)+\' \\u00b7 \'+esc(stripIouPrefix(v.submittedBy))+\' \\u00b7 \'+esc(v.expenseType)+\'</span>\'+\n' +
  '        \'<span style="font-weight:600;">Rs. \'+v.amount.toLocaleString("en-IN")+\'</span></label>\';\n' +
  '    }).join("");\n' +
  '    return \'<div class="rds-cg-batch" id="rdsCgBatch\'+bidx+\'">\'+\n' +
  '      \'<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#F5F6FD;\'+(bidx>0?"border-top:1px solid #ECEEFB;":"")+\'">\'+\n' +
  '        \'<label style="display:flex;align-items:center;gap:8px;font-size:14.5px;font-weight:600;cursor:pointer;flex:1;">\'+\n' +
  '          \'<input type="checkbox" class="rds-cg-batch-check" data-batch="\'+esc(bid)+\'"> \'+esc(bid)+\' <span style="font-weight:400;color:#5F6684;">(\'+lines.length+\' voucher(s), Rs. \'+batchTotal.toLocaleString("en-IN")+\')</span>\'+\n' +
  '        \'</label>\'+\n' +
  '        \'<button type="button" class="btn btn-outline btn-sm" style="width:auto;padding:4px 10px;font-size:13px;" onclick="el(\\\'rdsCgBatch\'+bidx+\'\\\').classList.toggle(\\\'expanded\\\')">Details</button>\'+\n' +
  '      \'</div>\'+\n' +
  '      \'<div class="rds-cg-batch-lines">\'+rowsHtml+\'</div>\'+\n' +
  '    \'</div>\';\n' +
  '  }).join("");\n' +
  '  document.querySelectorAll("#rdsCashGivenBatches .rds-cg-batch-check").forEach(function(cb){\n' +
  '    cb.addEventListener("change",function(){\n' +
  '      var bid=cb.getAttribute("data-batch");\n' +
  '      document.querySelectorAll(\'#rdsCashGivenBatches .rds-cg-voucher-check[data-batch="\'+bid+\'"]\').forEach(function(vc){\n' +
  '        vc.checked=cb.checked;toggleRdsCgSelection(vc);\n' +
  '      });\n' +
  '    });\n' +
  '  });\n' +
  '  document.querySelectorAll("#rdsCashGivenBatches .rds-cg-voucher-check").forEach(function(vc){\n' +
  '    vc.addEventListener("change",function(){\n' +
  '      toggleRdsCgSelection(vc);\n' +
  '      var bid=vc.getAttribute("data-batch");\n' +
  '      var all=document.querySelectorAll(\'#rdsCashGivenBatches .rds-cg-voucher-check[data-batch="\'+bid+\'"]\');\n' +
  '      var checkedCount=Array.prototype.filter.call(all,function(x){return x.checked;}).length;\n' +
  '      var batchCb=document.querySelector(\'#rdsCashGivenBatches .rds-cg-batch-check[data-batch="\'+bid+\'"]\');\n' +
  '      if(batchCb){batchCb.checked=checkedCount===all.length;batchCb.indeterminate=checkedCount>0&&checkedCount<all.length;}\n' +
  '    });\n' +
  '  });\n' +
  '  updateRdsCashGivenSelectedText();\n' +
  '}\n' +
  'function toggleRdsCgSelection(cb){\n' +
  '  var vid=cb.getAttribute("data-vid"),amt=parseFloat(cb.getAttribute("data-amt"))||0;\n' +
  '  if(cb.checked)_rdsCashGivenSelected[vid]=amt;else delete _rdsCashGivenSelected[vid];\n' +
  '  updateRdsCashGivenSelectedText();\n' +
  '}\n' +
  // Amount is prefilled to the selected total ONLY when the field is
  // still empty (first selection) — never overwrites a value Accounts
  // has already typed, since the whole point is that the handed-over
  // amount can differ from the computed total.
  'function updateRdsCashGivenSelectedText(){\n' +
  '  var ids=Object.keys(_rdsCashGivenSelected);\n' +
  '  var total=ids.reduce(function(s,id){return s+_rdsCashGivenSelected[id];},0);\n' +
  '  var text=el("rdsCashGivenSelectedText"),input=el("rdsCashGivenAmount");\n' +
  '  if(ids.length===0){\n' +
  '    text.textContent="Select at least one batch or voucher.";\n' +
  '  }else{\n' +
  '    text.innerHTML=ids.length+" voucher(s) selected \\u2014 Rs. "+total.toLocaleString("en-IN")+" computed.";\n' +
  '    if(!input.value)input.value=total;\n' +
  '  }\n' +
  '  el("rdsCashGivenAddBtn").disabled=!(ids.length>0&&parseFloat(input.value)>0);\n' +
  '}\n' +

  'function submitRdsCashGiven(){\n' +
  '  var amount=parseFloat(el("rdsCashGivenAmount").value);\n' +
  '  if(!amount||amount<=0){setInlineAlert("rdsCashGivenAlert","error","Enter a valid amount.");return;}\n' +
  '  var ids=Object.keys(_rdsCashGivenSelected);\n' +
  '  if(ids.length===0){setInlineAlert("rdsCashGivenAlert","error","Select at least one batch or voucher.");return;}\n' +
  '  var btn=el("rdsCashGivenAddBtn");btn.disabled=true;btn.textContent="Adding...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.textContent="Add Cash Given";\n' +
  '      if(!r||!r.success){setInlineAlert("rdsCashGivenAlert","error",(r&&r.error)||"Failed to add.");btn.disabled=false;return;}\n' +
  '      el("rdsCashGivenAmount").value="";\n' +
  '      setInlineAlert("rdsCashGivenAlert","success",r.message||"Cash Given added.");\n' +
  '      fetchRdsCashGivenStatus();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Add Cash Given";setInlineAlert("rdsCashGivenAlert","error","Server error: "+err);})\n' +
  '    .addRdsCashGiven(amount,JSON.stringify(ids),appToken);\n' +
  '}\n' +

  // ==========================================================================
  // CASH WITHDRAWAL BATCHES (bank-replenishment approval workflow) —
  // accounts-only panel, right below Cash Given on the same dashboard.
  // Batch-level selection only (see the HTML comment above this panel) —
  // simpler than Cash Given's per-voucher checklist since there's no
  // partial-batch case here.
  // ==========================================================================
  'var _cashWithdrawalSelected={};\n' +
  'function fetchCashWithdrawalStatus(){\n' +
  '  el("cashWithdrawalStatusText").textContent="Loading...";\n' +
  '  el("cashWithdrawalRequestBtn").disabled=true;\n' +
  '  _cashWithdrawalSelected={};\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){el("cashWithdrawalStatusText").textContent=(r&&r.error)||"Could not load status.";return;}\n' +
  '      renderCashWithdrawalBatches(r.batches||[]);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){el("cashWithdrawalStatusText").textContent="Server error: "+err;})\n' +
  '    .getEligibleWithdrawalBatches(appToken);\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){renderCashWithdrawalHistory((r&&r.success)?(r.requests||[]):[]);})\n' +
  '    .withFailureHandler(function(){el("cashWithdrawalHistory").textContent="Could not load history.";})\n' +
  '    .getCashWithdrawalBatchesLog(appToken);\n' +
  '}\n' +

  'function renderCashWithdrawalBatches(batches){\n' +
  '  var selectable=batches.filter(function(b){return b.selectable;});\n' +
  '  if(selectable.length===0){\n' +
  '    el("cashWithdrawalStatusText").textContent="No fully-approved batch is ready for a withdrawal request right now.";\n' +
  '  }else{\n' +
  '    el("cashWithdrawalStatusText").textContent=selectable.length+" batch(es) fully approved and ready \\u2014 select which to send to L2.";\n' +
  '  }\n' +
  // Non-selectable batches are still LISTED (greyed out, unchecked,
  // unclickable) with a short reason — so Accounts can see AT A GLANCE
  // why a batch isn\'t showing up as selectable (still pending/queried
  // vouchers, or already requested) rather than it just silently not
  // appearing, which would look like a bug.
  '  el("cashWithdrawalBatches").innerHTML=batches.map(function(b,bidx){\n' +
  '    var reason="";\n' +
  '    if(!b.selectable){\n' +
  '      if(b.blockedCount>0)reason="Waiting on "+b.blockedCount+" pending/queried voucher(s)";\n' +
  '      else if(b.alreadyRequestedCount>0)reason="Already requested";\n' +
  '      else reason="Nothing eligible in this batch";\n' +
  '    }\n' +
  '    return \'<label style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;font-size:14.5px;\'+(bidx>0?"border-top:1px solid #ECEEFB;":"")+(b.selectable?"cursor:pointer;":"opacity:0.55;")+\'">\'+\n' +
  '      \'<span style="display:flex;align-items:center;gap:8px;">\'+\n' +
  '        \'<input type="checkbox" class="cw-batch-check" data-batch="\'+esc(b.batchId)+\'" data-amt="\'+b.eligibleAmount+\'" \'+(b.selectable?"":"disabled")+\'>\'+\n' +
  '        \'<span>\'+esc(b.batchId)+\' <span style="font-weight:400;color:#5F6684;">(\'+b.eligibleCount+\' voucher(s))</span>\'+(reason?\' \\u2014 <span style="color:#C9915C;">\'+esc(reason)+"</span>":"")+\'</span>\'+\n' +
  '      \'</span>\'+\n' +
  '      \'<span style="font-weight:600;">Rs. \'+b.eligibleAmount.toLocaleString("en-IN")+\'</span>\'+\n' +
  '    \'</label>\';\n' +
  '  }).join("")||\'<div style="padding:16px;color:#5F6684;font-size:14px;">No batches yet.</div>\';\n' +
  '  document.querySelectorAll("#cashWithdrawalBatches .cw-batch-check").forEach(function(cb){\n' +
  '    cb.addEventListener("change",function(){\n' +
  '      var bid=cb.getAttribute("data-batch"),amt=parseFloat(cb.getAttribute("data-amt"))||0;\n' +
  '      if(cb.checked)_cashWithdrawalSelected[bid]=amt;else delete _cashWithdrawalSelected[bid];\n' +
  '      updateCashWithdrawalSelectedText();\n' +
  '    });\n' +
  '  });\n' +
  '  updateCashWithdrawalSelectedText();\n' +
  '}\n' +

  'function updateCashWithdrawalSelectedText(){\n' +
  '  var ids=Object.keys(_cashWithdrawalSelected);\n' +
  '  var total=ids.reduce(function(s,id){return s+_cashWithdrawalSelected[id];},0);\n' +
  '  var text=el("cashWithdrawalSelectedText");\n' +
  '  if(ids.length===0){\n' +
  '    text.textContent="Select at least one fully-approved batch.";\n' +
  '  }else{\n' +
  '    text.innerHTML=ids.length+" batch(es) selected \\u2014 Rs. "+total.toLocaleString("en-IN")+" total.";\n' +
  '  }\n' +
  '  el("cashWithdrawalRequestBtn").disabled=ids.length===0;\n' +
  '}\n' +

  'function submitCashWithdrawalRequest(){\n' +
  '  var ids=Object.keys(_cashWithdrawalSelected);\n' +
  '  if(ids.length===0){setInlineAlert("cashWithdrawalAlert","error","Select at least one batch.");return;}\n' +
  '  if(!confirm("Send a withdrawal approval request to L2 for "+ids.length+" batch(es)? This emails L2 (cc Accounts) with the Rabale Daily Sync extract attached."))return;\n' +
  '  var btn=el("cashWithdrawalRequestBtn");btn.disabled=true;btn.textContent="Sending...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.textContent="Email L2 for Approval";\n' +
  '      if(!r||!r.success){setInlineAlert("cashWithdrawalAlert","error",(r&&r.error)||"Failed to send request.");btn.disabled=false;return;}\n' +
  '      setInlineAlert("cashWithdrawalAlert","success",r.message||"Request sent.");\n' +
  '      fetchCashWithdrawalStatus();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Email L2 for Approval";setInlineAlert("cashWithdrawalAlert","error","Server error: "+err);})\n' +
  '    .triggerCashWithdrawalRequest(JSON.stringify(ids),appToken);\n' +
  '}\n' +

  'var CASH_WITHDRAWAL_STATUS_COLORS={"Pending L2 Approval":"#C9915C","Approved":"#1F5B45","Rejected":"#C95C5C"};\n' +
  'function renderCashWithdrawalHistory(requests){\n' +
  '  var host=el("cashWithdrawalHistory");\n' +
  '  if(!requests||requests.length===0){host.textContent="No withdrawal requests yet.";return;}\n' +
  '  host.innerHTML=requests.slice(0,8).map(function(r){\n' +
  '    var color=CASH_WITHDRAWAL_STATUS_COLORS[r.status]||"#454B6B";\n' +
  '    var decided=r.status!=="Pending L2 Approval"&&r.decidedBy?\' \\u2014 by \'+esc(r.decidedBy)+" ("+esc(r.decidedDate)+")":"";\n' +
  '    return \'<div style="padding:6px 0;border-top:1px dashed #ECEEFB;">\'+\n' +
  '      \'<strong>\'+esc(r.withdrawalId)+\'</strong> \\u2014 \'+esc(r.batchIds)+\' \\u2014 Rs. \'+r.totalAmount.toLocaleString("en-IN")+\n' +
  '      \' \\u2014 <span style="color:\'+color+\';font-weight:600;">\'+esc(r.status)+\'</span>\'+decided+\n' +
  '    \'</div>\';\n' +
  '  }).join("");\n' +
  '}\n' +

  // ==========================================================================
  // CASH ADVANCES — shared rendering helpers, used by three places: the
  // Submission Dashboard's inline panel (entry form lives there per
  // explicit instruction), the shared "Cash Advances" nav-strip page
  // (L1/accounts/L2, read-only), and the Admin tab's ledger viewer.
  // Written generically (element IDs passed in) instead of copy-pasted
  // three times.
  // ==========================================================================

  // Populates the entry form's Given To dropdown from the same list and
  // display convention (stripIouPrefix) as a voucher's Submitted By.
  'function loadCashAdvancesEntryForm(){\n' +
  '  el("cashAdvanceAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success)return;\n' +
  '      populateSelect("cashAdvanceGivenTo",r.employees,stripIouPrefix);\n' +
  '      makeSearchableSelect("cashAdvanceGivenTo");\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){setInlineAlert("cashAdvanceAlert","error","Server error: "+err);})\n' +
  '    .getCashAdvancePersons(appToken);\n' +
  '}\n' +
  'function submitCashAdvance(){\n' +
  '  var givenTo=el("cashAdvanceGivenTo").value;\n' +
  '  if(!givenTo){setInlineAlert("cashAdvanceAlert","error","Select who the advance is for.");return;}\n' +
  '  var amount=parseFloat(el("cashAdvanceAmount").value);\n' +
  '  if(!amount||amount<=0){setInlineAlert("cashAdvanceAlert","error","Enter a valid amount.");return;}\n' +
  '  var purpose=el("cashAdvancePurpose").value.trim();\n' +
  '  var btn=el("cashAdvanceAddBtn");btn.disabled=true;btn.textContent="Recording...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Record Advance";\n' +
  '      if(!r||!r.success){setInlineAlert("cashAdvanceAlert","error",(r&&r.error)||"Failed to record.");return;}\n' +
  '      el("cashAdvanceAmount").value="";el("cashAdvancePurpose").value="";el("cashAdvanceGivenTo").value="";syncSSLabel(el("cashAdvanceGivenTo"));\n' +
  '      setInlineAlert("cashAdvanceAlert","success",r.message||"Advance recorded.");\n' +
  '      fetchCashAdvancesBalancesInto("subDashAdvancesBalancesBody","subDashAdvancesBalancesEmpty","subDashAdvancesBalancesTable","subDashAdvancesLedgerPerson",true);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Record Advance";setInlineAlert("cashAdvanceAlert","error","Server error: "+err);})\n' +
  '    .recordCashAdvance(givenTo,amount,purpose,appToken);\n' +
  '}\n' +

  // Fetches balances into (tbodyId/emptyId/tableId) and, if ledgerSelectId
  // is given, also (re)populates that person picker from recordedPersons.
  // alertId defaults to the caller's own page alert if present.
  'var _caBalancesRawByTbody={};\n' +
  'function fetchCashAdvancesBalancesInto(tbodyId,emptyId,tableId,ledgerSelectId,isSubmissionPage){\n' +
  '  var alertId=isSubmissionPage?"subCashAdvancesAlert":"cashAdvancesAlert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert(alertId,"error",(r&&r.error)||"Failed to load balances.");return;}\n' +
  '      _caBalancesRawByTbody[tbodyId]=r.balances||[];\n' +
  '      applyBalancesFilterAndRender(tbodyId,emptyId,tableId,ledgerSelectId,isSubmissionPage);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert(alertId,"error","Server error: "+err);})\n' +
  '    .getCashAdvanceBalances(appToken);\n' +
  '  if(ledgerSelectId){\n' +
  '    google.script.run\n' +
  '      .withSuccessHandler(function(r){\n' +
  '        if(!r||!r.success)return;\n' +
  '        var sel=el(ledgerSelectId);var current=sel.value;\n' +
  '        sel.innerHTML=\'<option value="">-- Select --</option>\';\n' +
  '        (r.recordedPersons||[]).forEach(function(name){var o=document.createElement("option");o.value=name;o.textContent=stripIouPrefix(name);sel.appendChild(o);});\n' +
  '        if(current)sel.value=current;\n' +
  '      })\n' +
  '      .withFailureHandler(function(err){showAlert(alertId,"error","Server error: "+err);})\n' +
  '      .getCashAdvancePersons(appToken);\n' +
  '  }\n' +
  '}\n' +
  // Item 13 (24 Aug 2026) — Period + Flagged-only filters. Purely
  // client-side against the already-fetched balances array (small
  // dataset, one row per person with an open advance — no reason to
  // round-trip the server for a filter toggle). Filter element ids are
  // derived from tbodyId by convention (...Body -> ...Period /
  // ...FlaggedOnly), same derivation style fetchCashAdvanceLedgerInto
  // already uses for its Header id.
  'function parseDdMmYyyy(s){\n' +
  '  var m=/^(\\d{2})-(\\d{2})-(\\d{4})$/.exec(String(s||""));\n' +
  '  if(!m)return null;\n' +
  '  return new Date(parseInt(m[3],10),parseInt(m[2],10)-1,parseInt(m[1],10));\n' +
  '}\n' +
  'function applyBalancesFilterAndRender(tbodyId,emptyId,tableId,ledgerSelectId,isSubmissionPage){\n' +
  '  var prefix=tbodyId.replace(/Body$/,"");\n' +
  '  var raw=_caBalancesRawByTbody[tbodyId]||[];\n' +
  '  var periodEl=el(prefix+"Period"),flaggedEl=el(prefix+"FlaggedOnly");\n' +
  '  var periodDays=periodEl?parseInt(periodEl.value,10)||0:0;\n' +
  '  var flaggedOnly=flaggedEl?flaggedEl.checked:false;\n' +
  '  var cutoff=null;\n' +
  '  if(periodDays>0){cutoff=new Date();cutoff.setDate(cutoff.getDate()-periodDays);cutoff.setHours(0,0,0,0);}\n' +
  '  var filtered=raw.filter(function(b){\n' +
  '    if(flaggedOnly&&!b.flagged)return false;\n' +
  '    if(cutoff){\n' +
  '      var d=parseDdMmYyyy(b.oldestAdvanceDate);\n' +
  '      if(d&&d<cutoff)return false;\n' +
  '    }\n' +
  '    return true;\n' +
  '  });\n' +
  // The Submission Dashboard's "Cash Advances Outstanding" stat always
  // reflects the FULL unfiltered set, not whatever the person currently
  // has the Open Balances filter set to — a headline number that
  // silently changes because someone else\'s filter is still applied
  // would be misleading. renderCashAdvanceBalancesTable's stat-writing
  // branch is only ever fed the raw array for that reason.
  '  if(isSubmissionPage)renderCashAdvanceBalancesTable(tbodyId,emptyId,tableId,raw,ledgerSelectId,isSubmissionPage,true);\n' +
  '  renderCashAdvanceBalancesTable(tbodyId,emptyId,tableId,filtered,ledgerSelectId,isSubmissionPage,false);\n' +
  '}\n' +
  'function renderCashAdvanceBalancesTable(tbodyId,emptyId,tableId,balances,ledgerSelectId,isSubmissionPage,statOnly){\n' +
  '  if(statOnly){\n' +
  '    if(!el("subDashStatAdvances"))return;\n' +
  '    var openTotal=balances.reduce(function(s,b){return s+Math.max(b.openBalance,0);},0);\n' +
  '    var flaggedCount=balances.filter(function(b){return b.flagged;}).length;\n' +
  '    el("subDashStatAdvances").textContent="Rs. "+openTotal.toLocaleString("en-IN");\n' +
  '    el("subDashStatAdvancesSub").textContent=flaggedCount>0?(flaggedCount+" flagged \\u2014 open too long"):(balances.filter(function(b){return b.openBalance>0.004;}).length+" open");\n' +
  '    return;\n' +
  '  }\n' +
  '  var tbody=el(tbodyId),empty=el(emptyId),table=el(tableId);\n' +
  '  tbody.innerHTML="";\n' +
  '  if(balances.length===0){table.style.display="none";empty.classList.remove("hidden");return;}\n' +
  '  empty.classList.add("hidden");table.style.display="";\n' +
  '  balances.forEach(function(b){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    if(b.flagged)tr.style.background="#FBEDEC";\n' +
  '    var ageColor=b.flagged?"#A84545":(b.ageDays>14?"#8A5A17":"#454B6B");\n' +
  '    var ageCell=b.openBalance>0.004?("<td style=\\"color:"+ageColor+";font-weight:600;\\">"+b.ageDays+" day(s)"+(b.flagged?" \\u26A0":"")+"</td>"):"<td>\\u2014</td>";\n' +
  '    tr.innerHTML="<td>"+esc(stripIouPrefix(b.givenTo))+"</td><td>Rs. "+Math.round(b.totalGiven).toLocaleString("en-IN")+"</td><td>Rs. "+Math.round(b.totalSubmitted).toLocaleString("en-IN")+"</td>"+\n' +
  '      "<td style=\\"font-weight:700;\\">Rs. "+Math.round(b.openBalance).toLocaleString("en-IN")+"</td><td>"+esc(b.oldestAdvanceDate)+"</td>"+ageCell+\n' +
  '      (ledgerSelectId?("<td><button class=\\"btn btn-outline btn-sm\\" data-ledger-person=\\""+esc(b.givenTo)+"\\">View Ledger</button></td>"):"<td></td>");\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '  if(ledgerSelectId){\n' +
  '    tbody.querySelectorAll("[data-ledger-person]").forEach(function(btn){\n' +
  '      btn.addEventListener("click",function(){\n' +
  '        var sel=el(ledgerSelectId);sel.value=btn.getAttribute("data-ledger-person");\n' +
  '        sel.dispatchEvent(new Event("change"));\n' +
  '      });\n' +
  '    });\n' +
  '  }\n' +
  '}\n' +

  // Fetches + renders one person's ledger into (tableId/bodyId/emptyId),
  // plus a status header (avatar/name/open-balance badge) into the
  // matching *Header element, derived from tableId by convention
  // (...Table -> ...Header, see the 3 markup instances above).
  // alertId matches whichever page called this.
  'var _caLedgerRawByTable={};\n' +
  'function fetchCashAdvanceLedgerInto(personSelectId,tableId,bodyId,emptyId,alertId){\n' +
  '  var person=el(personSelectId).value;\n' +
  '  var headerId=tableId.replace(/Table$/,"Header");\n' +
  '  if(!person){el(tableId).classList.add("hidden");el(emptyId).classList.add("hidden");el(headerId).classList.add("hidden");return;}\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert(alertId,"error",(r&&r.error)||"Failed to load ledger.");return;}\n' +
  '      renderCashAdvanceLedgerHeader(headerId,r);\n' +
  '      _caLedgerRawByTable[tableId]=r.entries||[];\n' +
  '      renderCashAdvanceLedgerTable(tableId,bodyId,emptyId,filterLedgerEntriesByDate(tableId,r.entries||[]));\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert(alertId,"error","Server error: "+err);})\n' +
  '    .getCashAdvanceLedger(person,appToken);\n' +
  '}\n' +
  // Item 13 (24 Aug 2026) — Date From/To filter, client-side against the
  // already-fetched ledger entries (same reasoning as the balances
  // filter above: small per-person dataset already in memory, no reason
  // to round-trip the server). fromId/toId are passed explicitly rather
  // than derived, since the date inputs don\'t follow the tableId-suffix
  // convention the Period/FlaggedOnly ones do.
  '  function parseLedgerEntryDate(s){return parseDdMmYyyy(s);}\n' +
  '  function filterLedgerEntriesByDate(tableId,entries){\n' +
  '    var prefix=tableId.replace(/Table$/,"");\n' +
  '    var fromEl=el(prefix+"DateFrom"),toEl=el(prefix+"DateTo");\n' +
  '    var from=fromEl&&fromEl.value?new Date(fromEl.value+"T00:00:00"):null;\n' +
  '    var to=toEl&&toEl.value?new Date(toEl.value+"T23:59:59"):null;\n' +
  '    if(!from&&!to)return entries;\n' +
  '    return entries.filter(function(e){\n' +
  '      var d=parseLedgerEntryDate(e.date);\n' +
  '      if(!d)return true;\n' +
  '      if(from&&d<from)return false;\n' +
  '      if(to&&d>to)return false;\n' +
  '      return true;\n' +
  '    });\n' +
  '  }\n' +
  '  function applyLedgerDateFilter(tableId,fromId,toId){\n' +
  '    var raw=_caLedgerRawByTable[tableId]||[];\n' +
  '    var bodyId=tableId.replace(/Table$/,"Body"),emptyId=tableId.replace(/Table$/,"Empty");\n' +
  '    renderCashAdvanceLedgerTable(tableId,bodyId,emptyId,filterLedgerEntriesByDate(tableId,raw));\n' +
  '  }\n' +
  'function renderCashAdvanceLedgerHeader(headerId,r){\n' +
  '  var el2=el(headerId);\n' +
  '  var badgeClass=r.status==="flagged"?"badge-flag":(r.status==="settled"?"badge-settled":"badge-open");\n' +
  '  el2.innerHTML=\'<div style="display:flex;justify-content:space-between;align-items:center;">\'+\n' +
  '    \'<div style="display:flex;align-items:center;gap:10px;"><div class="ca-ledger-avatar">\'+esc(r.initials)+\'</div>\'+\n' +
  '    \'<div style="font-weight:700;font-size:14px;">\'+esc(r.personName)+\' <span class="ca-daily-badge \'+badgeClass+\'">\'+esc(r.statusLabel)+\'</span></div></div>\'+\n' +
  '    \'<div style="text-align:right;"><div style="font-size:11.5px;text-transform:uppercase;color:#5F6684;">Open balance</div><div style="font-size:18px;font-weight:700;color:#C98A34;">Rs. \'+Math.round(r.closingBalance>0.004?r.closingBalance:0).toLocaleString("en-IN")+\'</div></div></div>\';\n' +
  '  el2.classList.remove("hidden");\n' +
  '}\n' +
  'function renderCashAdvanceLedgerTable(tableId,bodyId,emptyId,entries){\n' +
  '  var tbody=el(bodyId),empty=el(emptyId),table=el(tableId);\n' +
  '  tbody.innerHTML="";\n' +
  '  if(entries.length===0){table.classList.add("hidden");empty.classList.remove("hidden");return;}\n' +
  '  empty.classList.add("hidden");table.classList.remove("hidden");\n' +
  '  entries.forEach(function(e){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    var pillClass=e.type==="Advance"?"ca-ledger-type-advance":"ca-ledger-type-voucher";\n' +
  '    tr.innerHTML="<td>"+esc(e.date)+"</td><td><span class=\\"ca-ledger-type-pill "+pillClass+"\\">"+esc(e.type)+"</span></td><td>"+esc(e.ref)+"</td><td>"+esc(e.description)+"</td>"+\n' +
  '      "<td>"+(e.dr?"<span class=\\"ca-ledger-dr\\">Rs. "+Math.round(e.dr).toLocaleString("en-IN")+"</span>":"\\u2014")+"</td>"+\n' +
  '      "<td>"+(e.cr?"<span class=\\"ca-ledger-cr\\">Rs. "+Math.round(e.cr).toLocaleString("en-IN")+"</span>":"\\u2014")+"</td>"+\n' +
  '      "<td style=\\"font-weight:700;\\" class=\\"ca-ledger-balance"+(e.balance<0?" negative":"")+"\\">Rs. "+Math.round(e.balance).toLocaleString("en-IN")+"</td>";\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '}\n' +

  // ==========================================================================
  // CASH ADVANCES PAGE — shared Balances + Ledger view, reached via the
  // "Cash Advances" nav-strip tab (L1/accounts/L2). Read-only here by
  // design — recording a new advance lives on the Submission Dashboard,
  // the one place that form exists.
  // ==========================================================================
  'function loadCashAdvancesPage(){\n' +
  '  showPage("cashAdvancesPage");\n' +
  '  el("cashAdvancesAlert").className="alert";\n' +
  '  el("cashAdvancesLedgerTable").classList.add("hidden");\n' +
  '  el("cashAdvancesLedgerEmpty").classList.add("hidden");\n' +
  '  fetchCashAdvancesBalances();\n' +
  '  fetchCashAdvanceDailyLog("ca","cashAdvancesAlert");\n' +
  '}\n' +
  'function fetchCashAdvancesBalances(){\n' +
  '  fetchCashAdvancesBalancesInto("cashAdvancesBalancesBody","cashAdvancesBalancesEmpty","cashAdvancesBalancesTable","cashAdvancesLedgerPerson",false);\n' +
  '}\n' +
  'function fetchCashAdvanceLedger(){\n' +
  '  fetchCashAdvanceLedgerInto("cashAdvancesLedgerPerson","cashAdvancesLedgerTable","cashAdvancesLedgerBody","cashAdvancesLedgerEmpty","cashAdvancesAlert");\n' +
  '}\n' +

  // ==========================================================================
  // DAILY LOG — Reconciliation + Breakdown (per explicit instruction).
  // Both sub-views render from ONE fetch (getCashAdvanceDailyBreakdown,
  // Advances.gs) so they can never show different numbers — switching
  // tabs only changes presentation, never re-fetches.
  //
  // REVISED 24 Aug 2026 (item 13) — CONSOLIDATED from two parallel
  // hand-duplicated implementations (one per page) into one parameterized
  // set, keyed by an id prefix ("ca" for the shared Cash Advances page,
  // "subDashCa" for the Submission Dashboard — both already followed
  // that exact naming convention, so no HTML ids needed renaming). This
  // reverses the "keep pages independently duplicated" call from the
  // prior session: that was fine for a static toggle, but a period
  // selector adds real logic that would otherwise need to be built and
  // maintained twice. Both pages still fetch/render completely
  // independently at runtime (their own cache slot in
  // _caDailyLogDataByPrefix) — this only removes the duplicate CODE, not
  // any independence between the two pages' displayed data.
  // ==========================================================================
  'var _caDailyLogDataByPrefix={};\n' +
  'function fetchCashAdvanceDailyLog(prefix,alertId){\n' +
  '  var days=parseInt(el(prefix+"DailyLogPeriod").value,10)||14;\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert(alertId,"error",(r&&r.error)||"Failed to load daily log.");return;}\n' +
  '      _caDailyLogDataByPrefix[prefix]=r.days||[];\n' +
  '      var empty=el(prefix+"DailyLogEmpty");\n' +
  '      empty.classList.toggle("hidden",_caDailyLogDataByPrefix[prefix].length>0);\n' +
  '      renderCaDailyLogRecon(prefix);\n' +
  '      renderCaDailyLogBreakdown(prefix);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert(alertId,"error","Server error: "+err);})\n' +
  '    .getCashAdvanceDailyBreakdown(days,appToken);\n' +
  '}\n' +
  'function caDailyLogInr(n){return "Rs. "+Math.round(n).toLocaleString("en-IN");}\n' +
  'function caDailyLogBadgeClass(status){return status==="settled"?"badge-settled":(status==="flagged"?"badge-flag":"badge-open");}\n' +
  'function renderCaDailyLogRecon(prefix){\n' +
  '  var body=el(prefix+"DailyLogBody");\n' +
  '  var data=_caDailyLogDataByPrefix[prefix]||[];\n' +
  '  body.innerHTML=data.map(function(d,idx){\n' +
  '    var rowStyle=d.lag?"box-shadow:inset 3px 0 0 #C98A34;":"";\n' +
  '    var peopleCount=d.people.length?(d.people.length+(d.people.length===1?" person":" people")):"\u2014";\n' +
  '    var noteHtml=d.lag?(\'<span class="ca-daily-tag">\'+(d.advanceTotal>0&&d.voucherTotal<=0?"Filing pending":"Backlog filed")+\'</span>\'):"";\n' +
  '    var detail=!d.people.length?\'<div class="empty-state" style="padding:10px 0;"><p>No advances given this day.</p></div>\':\n' +
  '      d.people.map(function(p){\n' +
  '        return \'<div class="person-row" style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px dashed #ECEEFB;">\'+\n' +
  '          \'<div><span style="font-weight:600;font-size:14px;">\'+esc(p.name)+\'</span> <span class="ca-daily-badge \'+caDailyLogBadgeClass(p.status)+\'">\'+esc(p.statusLabel)+\'</span><div style="font-size:12.5px;color:#5F6684;">\'+esc(p.purpose)+\'</div></div>\'+\n' +
  '          \'<div style="font-weight:700;font-size:14.5px;">\'+caDailyLogInr(p.amount)+\'</div></div>\';\n' +
  '      }).join("");\n' +
  '    return \'<tr style="cursor:pointer;\'+rowStyle+\'" onclick="toggleCaDailyLogDetail(\\\'\'+prefix+\'\\\',\'+idx+\')">\'+\n' +
  '      \'<td style="font-weight:700;white-space:nowrap;">\'+esc(d.date)+\'</td>\'+\n' +
  '      \'<td style="font-weight:700;color:#C98A34;">\'+caDailyLogInr(d.advanceTotal)+\'</td>\'+\n' +
  '      \'<td style="font-weight:700;color:#2E3192;">\'+caDailyLogInr(d.voucherTotal)+\'</td>\'+\n' +
  '      \'<td style="font-size:13px;color:#5F6684;">\'+peopleCount+\' \'+noteHtml+\'</td></tr>\'+\n' +
  '      \'<tr id="\'+prefix+\'DailyLogDetail\'+idx+\'" style="display:none;"><td colspan="4" style="padding:4px 10px 14px;background:#F5F6FD;">\'+detail+\'</td></tr>\';\n' +
  '  }).join("");\n' +
  '}\n' +
  'function toggleCaDailyLogDetail(prefix,idx){\n' +
  '  var row=el(prefix+"DailyLogDetail"+idx);\n' +
  '  row.style.display=row.style.display==="none"?"table-row":"none";\n' +
  '}\n' +
  'window.toggleCaDailyLogDetail=toggleCaDailyLogDetail;\n' +
  'function renderCaDailyLogBreakdown(prefix){\n' +
  '  var body=el(prefix+"DailyLogBreakdown");\n' +
  '  var data=_caDailyLogDataByPrefix[prefix]||[];\n' +
  '  body.innerHTML=data.map(function(d,idx){\n' +
  '    var peopleCount=d.people.length?(d.people.length+(d.people.length===1?" advance":" advances")):"0 advances";\n' +
  '    var inner=!d.people.length?\'<div class="empty-state" style="padding:10px 0;"><p>No advances given this day.</p></div>\':\n' +
  '      d.people.map(function(p){\n' +
  '        return \'<div class="person-row" style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px dashed #ECEEFB;">\'+\n' +
  '          \'<div><span style="font-weight:600;font-size:14px;">\'+esc(p.name)+\'</span> <span class="ca-daily-badge \'+caDailyLogBadgeClass(p.status)+\'">\'+esc(p.statusLabel)+\'</span><div style="font-size:12.5px;color:#5F6684;">\'+esc(p.purpose)+\'</div></div>\'+\n' +
  '          \'<div style="font-weight:700;font-size:15px;">\'+caDailyLogInr(p.amount)+\'</div></div>\';\n' +
  '      }).join("");\n' +
  '    return \'<div class="day-card-ca\'+(idx===0?" open":"")+\'" id="\'+prefix+\'DayCard\'+idx+\'">\'+\n' +
  '      \'<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 4px;cursor:pointer;" onclick="el(\\\'\'+prefix+\'DayCard\'+idx+\'\\\').classList.toggle(\\\'open\\\')">\'+\n' +
  '      \'<div><span style="font-weight:700;font-size:15px;">\'+esc(d.date)+\'</span><span style="font-size:13px;color:#454B6B;margin-left:10px;">\'+peopleCount+\' \u00b7 \'+caDailyLogInr(d.voucherTotal)+\' filed same day</span></div>\'+\n' +
  '      \'<div style="display:flex;gap:16px;align-items:center;"><div style="text-align:right;"><div style="font-size:11px;text-transform:uppercase;color:#5F6684;">Advance</div><div style="font-weight:700;color:#C98A34;">\'+caDailyLogInr(d.advanceTotal)+\'</div></div></div></div>\'+\n' +
  '      \'<div class="day-card-ca-body">\'+inner+\'</div></div>\';\n' +
  '  }).join("");\n' +
  '}\n' +
  'function wireDailyLogTabs(tabsId,reconId,breakdownId){\n' +
  '  document.querySelectorAll("#"+tabsId+" .filter-btn").forEach(function(btn){\n' +
  '    btn.addEventListener("click",function(){\n' +
  '      document.querySelectorAll("#"+tabsId+" .filter-btn").forEach(function(b){b.classList.remove("active");});\n' +
  '      btn.classList.add("active");\n' +
  '      var view=btn.getAttribute("data-ca-daily-view");\n' +
  '      el(reconId).classList.toggle("hidden",view!=="recon");\n' +
  '      el(breakdownId).classList.toggle("hidden",view!=="breakdown");\n' +
  '    });\n' +
  '  });\n' +
  '}\n' +
  'wireDailyLogTabs("caDailyLogTabs","caDailyLogRecon","caDailyLogBreakdown");\n' +
  'wireDailyLogTabs("subDashCaDailyLogTabs","subDashCaDailyLogRecon","subDashCaDailyLogBreakdown");\n' +
  'el("caDailyLogRefreshBtn").addEventListener("click",function(){fetchCashAdvanceDailyLog("ca","cashAdvancesAlert");});\n' +
  'el("caDailyLogPeriod").addEventListener("change",function(){fetchCashAdvanceDailyLog("ca","cashAdvancesAlert");});\n' +
  'el("subDashCaDailyLogRefreshBtn").addEventListener("click",function(){fetchCashAdvanceDailyLog("subDashCa","subCashAdvancesAlert");});\n' +
  'el("subDashCaDailyLogPeriod").addEventListener("change",function(){fetchCashAdvanceDailyLog("subDashCa","subCashAdvancesAlert");});\n' +


  'function loadAdminDashboard(){\n' +
  '  showPage("adminPage");\n' +
  '  switchAdminTab("vendor");\n' +
  '  fetchAdminVendors();\n' +
  '  fetchAdminVouchers();\n' +
  '  fetchAdminUsers();\n' +
  '}\n' +

  'function switchAdminTab(tab){\n' +
  '  document.querySelectorAll(".admin-tab-content").forEach(function(el){el.classList.add("hidden");});\n' +
  '  el("adminTab"+tab.charAt(0).toUpperCase()+tab.slice(1)).classList.remove("hidden");\n' +
  '  document.querySelectorAll("#adminTabBtns .admin-nav-tab").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-admin-tab")===tab);});\n' +
  '}\n' +

  // ============================================================================
  // AUDITOR DASHBOARD (read-only) — mirrors the Admin/Tally Export pages\'
  // own tab-switch and filter-bar conventions (switchAdminTab,
  // getFilterCriteria/sortVouchers/liveSearch, all already prefix-generic)
  // rather than inventing new patterns. _auditorVouchers is this page\'s
  // own cache, same as every other dashboard keeps its own.
  // ============================================================================
  'var _auditorVouchers=[],currentAuditorFilters={};\n' +
  'function loadAuditorDashboard(){\n' +
  '  showPage("auditorPage");\n' +
  '  switchAuditorTab("vouchers");\n' +
  '  fetchAuditorVouchers();\n' +
  '}\n' +

  'function switchAuditorTab(tab){\n' +
  '  document.querySelectorAll(".auditor-tab-content").forEach(function(e){e.classList.add("hidden");});\n' +
  '  el("auditorTab"+tab.charAt(0).toUpperCase()+tab.slice(1)).classList.remove("hidden");\n' +
  '  document.querySelectorAll("#auditorTabBtns .admin-nav-tab").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-auditor-tab")===tab);});\n' +
  '  if(tab==="log")fetchAuditLog();\n' +
  '}\n' +

  'function fetchAuditorVouchers(){\n' +
  '  el("auditorAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("auditorAlert","error",(r&&r.error)||"Failed to load vouchers.");return;}\n' +
  '      _auditorVouchers=r.vouchers;\n' +
  '      populateBatchIdOptions("auditor",_auditorVouchers);\n' +
  '      renderAuditorVouchers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("auditorAlert","error","Server error: "+err);})\n' +
  '    .getAllVouchers(appToken);\n' +
  '}\n' +

  'function renderAuditorVouchers(){\n' +
  '  var rows=_auditorVouchers.filter(function(v){return voucherMatchesFilters(v,currentAuditorFilters);});\n' +
  '  rows=sortVouchers(rows,el("auditorSortBy").value);\n' +
  '  var tbody=el("auditorVouchersBody"),empty=el("auditorVouchersEmptyState"),table=el("auditorVouchersTable");\n' +
  '  tbody.innerHTML="";\n' +
  '  if(rows.length===0){\n' +
  // Auditor has no status-tab concept (unlike the other 4 pages) — only
  // the shared filter-bar criteria object, which can hold several fields
  // at once, so there is no single filter VALUE to name the way
  // currentFilter/currentAdminStatusFilter/currentMyVouchersStatusFilter
  // can on the other pages. "Active" here just means ANY bar field is
  // set; the clear action reuses the page\'s real #auditorClearFilters
  // button (same reset path the person already has), same as elsewhere.
  '    var auditorFilterActive=Object.keys(currentAuditorFilters||{}).some(function(k){return !!currentAuditorFilters[k];});\n' +
  '    setEmptyStateFilterInfo("auditorVouchersEmptyTitle","auditorVouchersEmptySub","auditorVouchersEmptyClearBtn","No vouchers match these filters",auditorFilterActive?"your filters":null,function(){el("auditorClearFilters").click();});\n' +
  '    empty.classList.remove("hidden");table.style.display="none";return;\n' +
  '  }\n' +
  '  empty.classList.add("hidden");table.style.display="";\n' +
  '  rows.forEach(function(v){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    var hasQuery=v.queryStatus&&v.queryStatus!=="No Query";\n' +
  // Query dropped from the always-visible column set \u2014 reclaims width
  // for the columns that matter on every row (per Fix N\'s stated intent).
  // View/History stay exactly as they were; a small query indicator is
  // added alongside them ONLY when a query genuinely exists for that row
  // (matching data the row already has \u2014 no new RPC, no new read).
  '    var queryIndicator=hasQuery?\' <span class="badge badge-query" title="\'+esc(v.queryStatus)+\'">Query</span>\':"";\n' +
  '    tr.innerHTML="<td>"+esc(v.voucherId)+"</td><td>"+esc(stripIouPrefix(v.submittedBy))+"</td>"+\n' +
  '      \'<td class="amt-cell">Rs. \'+v.amount.toLocaleString("en-IN")+"</td>"+\n' +
  '      \'<td><span class="badge \'+(v.status==="Approved"?"badge-approved":v.status==="Rejected"?"badge-rejected":"badge-pending")+\'">\'+esc(v.status)+"</span></td>"+\n' +
  '      "<td>"+esc(v.date)+"</td>"+\n' +
  '      \'<td style="color:#454B6B;">\'+esc(v.actualExpenseDate||v.date)+"</td>"+\n' +
  // Checkmark/dash instead of Yes/No text \u2014 visual only, the
  // underlying boolean read (v.cashReleased truthy, v.tallyCoded truthy)
  // is unchanged from before.
  '      \'<td style="text-align:center;" title="\'+(v.cashReleased?"Cash Released":"Cash not yet released")+\'">\'+(v.cashReleased?"\\u2713":"\\u2014")+"</td>"+\n' +
  '      \'<td style="text-align:center;" title="\'+(v.tallyCoded?"Exported to Tally":"Not yet exported to Tally")+\'">\'+(v.tallyCoded?"\\u2713":"\\u2014")+"</td>"+\n' +
  '      \'<td><div class="action-btns"><button class="btn btn-outline btn-sm" data-audview-vid="\'+esc(v.voucherId)+\'">View</button>\'+\n' +
  '      \'<button class="btn btn-outline btn-sm" data-audhist-vid="\'+esc(v.voucherId)+\'">History</button>\'+queryIndicator+\'</div></td>\';\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '  tbody.querySelectorAll("[data-audview-vid]").forEach(function(b){\n' +
  '    b.addEventListener("click",function(){viewDetail(b.getAttribute("data-audview-vid"),_auditorVouchers);});\n' +
  '  });\n' +
  '  tbody.querySelectorAll("[data-audhist-vid]").forEach(function(b){\n' +
  '    b.addEventListener("click",function(){openVoucherHistory(b.getAttribute("data-audhist-vid"));});\n' +
  '  });\n' +
  '}\n' +

  'function fetchAuditLog(){\n' +
  '  el("auditorAlert").className="alert";\n' +
  '  var filters={voucherId:el("auditLogVoucherId").value.trim(),action:el("auditLogAction").value.trim(),actor:el("auditLogActor").value.trim()};\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("auditorAlert","error",(r&&r.error)||"Failed to load audit log.");return;}\n' +
  '      renderAuditLog(r.entries||[]);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("auditorAlert","error","Server error: "+err);})\n' +
  '    .getAuditLogEntries(filters,appToken);\n' +
  '}\n' +

  // Shared action->color-class mapping (design pass) — used by both the
  // Audit Log row accent bar and the History timeline dots, so an action
  // reads the same color everywhere. Falls back to \'act-system\' (neutral
  // gray) for anything not explicitly categorized, rather than guessing.
  'var ACTION_CLASS_MAP={APPROVE:"act-approve",REJECT:"act-reject",QUERY:"act-query",\n' +
  '  QUERY_RESPONSE:"act-submit",SUBMIT:"act-submit",RESUBMIT:"act-submit",\n' +
  '  LOGIN:"act-system",LOGOUT:"act-system",TALLY_EXPORT:"act-system",SYNC_WARNING:"act-system"};\n' +
  'function actionClass(action){\n' +
  '  if(ACTION_CLASS_MAP[action])return ACTION_CLASS_MAP[action];\n' +
  '  if(String(action||"").indexOf("REJECT")>=0)return "act-reject";\n' +
  '  if(String(action||"").indexOf("APPROVE")>=0)return "act-approve";\n' +
  '  if(String(action||"").indexOf("QUERY")>=0)return "act-query";\n' +
  '  return "act-system";\n' +
  '}\n' +

  'function renderAuditLog(entries){\n' +
  '  var list=el("auditLogBody"),empty=el("auditLogEmptyState"),wrap=el("auditLogTable");\n' +
  '  list.innerHTML="";\n' +
  '  if(entries.length===0){empty.classList.remove("hidden");wrap.style.display="none";return;}\n' +
  '  empty.classList.add("hidden");wrap.style.display="";\n' +
  '  var h="";\n' +
  '  entries.forEach(function(e){\n' +
  '    var cls=actionClass(e.action);\n' +
  '    var vid=e.voucherId?\' <button class="audit-vid-link" data-audhist-vid="\'+esc(e.voucherId)+\'">\'+esc(e.voucherId)+\'</button>\':"";\n' +
  '    var who=esc(e.actor)+((e.position||e.role)?" ("+esc(e.position||e.role)+")":"");\n' +
  '    h+=\'<div class="timeline-item"><span class="act-dot \'+cls+\'"></span>\'+\n' +
  '      \'<div class="ti-head"><strong>\'+esc(e.action)+\'</strong>\'+vid+\'<span class="ti-when">\'+esc(e.timestamp)+\'</span></div>\'+\n' +
  '      \'<div class="ti-notes">\'+who+(e.notes?" \\u2014 "+esc(e.notes):"")+\'</div></div>\';\n' +
  '  });\n' +
  '  list.innerHTML=h;\n' +
  '  list.querySelectorAll("[data-audhist-vid]").forEach(function(b){\n' +
  '    b.addEventListener("click",function(){openVoucherHistory(b.getAttribute("data-audhist-vid"));});\n' +
  '  });\n' +
  '}\n' +

  // Version-diff history modal — one voucher\'s full timeline, with a
  // per-entry "View Changes" toggle for anything carrying a structured
  // diff (parseAuditSnapshotDiff already computed server-side which
  // fields actually changed, so this just renders that list, no
  // client-side comparison logic duplicated here).
  'function openVoucherHistory(vid){\n' +
  '  el("auditorHistoryVid").textContent=vid;\n' +
  '  el("auditorHistoryAlert").className="alert";\n' +
  '  el("auditorHistoryTimeline").innerHTML="Loading...";\n' +
  '  el("auditorHistoryTallySection").innerHTML="";\n' +
  '  el("auditorHistoryModal").classList.add("show");\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){el("auditorHistoryTimeline").innerHTML="";showAlert("auditorHistoryAlert","error",(r&&r.error)||"Failed to load history.");return;}\n' +
  '      renderHistoryTimeline(r.timeline||[]);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){el("auditorHistoryTimeline").innerHTML="";showAlert("auditorHistoryAlert","error","Server error: "+err);})\n' +
  '    .getVoucherEditHistory(vid,appToken);\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success||!r.rows||r.rows.length===0)return;\n' +
  '      var h=\'<div class="section-title" style="border:none;margin:0 0 8px;padding:0;font-size:14px;">Tally Export Rows</div><table style="width:100%;border-collapse:collapse;font-size:13.5px;">\';\n' +
  '      h+="<tr><th style=\'text-align:left;padding:4px;\'>Ledger</th><th style=\'text-align:left;padding:4px;\'>Amount</th><th style=\'text-align:left;padding:4px;\'>Dr/Cr</th></tr>";\n' +
  '      r.rows.forEach(function(row){h+="<tr><td style=\'padding:4px;border-top:1px solid #D9DDF0;\'>"+esc(row.ledgerName)+"</td><td style=\'padding:4px;border-top:1px solid #D9DDF0;\'>Rs. "+row.ledgerAmt.toLocaleString("en-IN")+"</td><td style=\'padding:4px;border-top:1px solid #D9DDF0;\'>"+esc(row.drCr)+"</td></tr>";});\n' +
  '      h+="</table>";\n' +
  '      el("auditorHistoryTallySection").innerHTML=h;\n' +
  '    })\n' +
  '    .withFailureHandler(function(){})\n' +
  '    .getTallyExportRowsForVoucher(vid,appToken);\n' +
  '}\n' +

  'var FRIENDLY_AUDIT_FIELD_NAMES={expenseType:"Expense Type",submittedBy:"Submitted By",vehicleNo:"Vehicle No.",costCentre:"Cost Centre",amount:"Amount",notes:"Notes",actualExpenseDate:"Actual Expense Date",billFiles:"Bill Files",status:"Status"};\n' +
  'function renderHistoryTimeline(timeline){\n' +
  '  if(timeline.length===0){el("auditorHistoryTimeline").innerHTML=\'<p style="color:#454B6B;">No history found for this voucher.</p>\';return;}\n' +
  '  var h=\'<div class="timeline">\';\n' +
  '  timeline.forEach(function(e,i){\n' +
  '    var cls=actionClass(e.action);\n' +
  '    var isQuery=(e.action==="QUERY");\n' +
  '    h+=\'<div class="timeline-item\'+(isQuery?" ti-query":"")+\'"><span class="act-dot \'+cls+\'"></span>\';\n' +
  '    h+=\'<div style="display:flex;justify-content:space-between;align-items:center;">\';\n' +
  '    h+=\'<div class="ti-head \'+cls+\'"><strong>\'+esc(e.action)+\'</strong><span class="ti-when">by \'+esc(e.actor)+\' (\'+esc(e.position||e.role)+\') \\u2014 \'+esc(e.timestamp)+\'</span></div>\';\n' +
  '    if(e.hasDiff&&e.diff)h+=\'<button class="btn btn-outline btn-sm" data-diff-toggle="\'+i+\'" style="width:auto;">View Changes</button>\';\n' +
  '    h+="</div>";\n' +
  '    if(e.notes)h+=\'<div class="ti-notes">\'+esc(e.notes)+"</div>";\n' +
  '    if(e.hasDiff&&e.diff){\n' +
  '      h+=\'<div id="diffBody\'+i+\'" class="hidden" style="margin-top:8px;background:#F5F6FD;border:1px solid #D9DDF0;border-radius:8px;padding:10px;">\';\n' +
  '      if(e.diff.after===null){\n' +
  '        h+=\'<p style="font-size:13.5px;color:#A84545;font-weight:600;margin:0 0 8px;">Voucher deleted \\u2014 last known values:</p>\';\n' +
  '        Object.keys(e.diff.before).forEach(function(k){\n' +
  '          if(k==="vendorLines")return;\n' +
  '          h+=\'<div style="font-size:13.5px;padding:2px 0;"><strong>\'+esc(FRIENDLY_AUDIT_FIELD_NAMES[k]||k)+\':</strong> \'+esc(String(e.diff.before[k]))+"</div>";\n' +
  '        });\n' +
  '      }else if(e.diff.changedFields&&e.diff.changedFields.length>0){\n' +
  '        h+=\'<table style="width:100%;font-size:13.5px;border-collapse:collapse;">\';\n' +
  '        h+="<tr><th style=\'text-align:left;padding:4px;\'>Field</th><th style=\'text-align:left;padding:4px;color:#8B3A3A;\'>Before</th><th style=\'text-align:left;padding:4px;color:#1F5B45;\'>\\u2192 After</th></tr>";\n' +
  '        e.diff.changedFields.forEach(function(cf){\n' +
  '          h+="<tr><td style=\'padding:4px;border-top:1px solid #D9DDF0;font-weight:600;\'>"+esc(FRIENDLY_AUDIT_FIELD_NAMES[cf.field]||cf.field)+"</td>"+\n' +
  '            "<td style=\'padding:4px;border-top:1px solid #D9DDF0;color:#A84545;\'>"+esc(String(cf.before))+"</td>"+\n' +
  '            "<td style=\'padding:4px;border-top:1px solid #D9DDF0;color:#1F5B45;\'>"+esc(String(cf.after))+"</td></tr>";\n' +
  '        });\n' +
  '        h+="</table>";\n' +
  '      }else{\n' +
  '        h+=\'<p style="font-size:13.5px;color:#454B6B;margin:0;">No field-level changes detected.</p>\';\n' +
  '      }\n' +
  '      h+="</div>";\n' +
  '    }\n' +
  '    h+="</div>";\n' +
  '  });\n' +
  '  h+="</div>";\n' +
  '  el("auditorHistoryTimeline").innerHTML=h;\n' +
  '  document.querySelectorAll("[data-diff-toggle]").forEach(function(b){\n' +
  '    b.addEventListener("click",function(){el("diffBody"+b.getAttribute("data-diff-toggle")).classList.toggle("hidden");});\n' +
  '  });\n' +
  '}\n' +

  // Admin Cash Given override — list/edit/remove today\'s "Cash Given by
  // Accounts" RDS entries. Fetched on demand (tab switch / refresh), not
  // pre-loaded with the rest of the Admin dashboard, since it reflects
  // today\'s live state and could go stale between page load and use.
  'var _cashGivenEditTarget=null;\n' +
  'function fetchAdminCashGivenEntries(){\n' +
  '  el("adminCashGivenAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminCashGivenAlert","error",(r&&r.error)||"Failed to load entries.");return;}\n' +
  '      renderAdminCashGivenTable(r.entries||[]);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminCashGivenAlert","error","Server error: "+err);})\n' +
  '    .getTodaysRdsCashGivenEntriesForAdmin(appToken);\n' +
  '}\n' +
  'function renderAdminCashGivenTable(entries){\n' +
  '  var tbody=el("adminCashGivenBody"),empty=el("adminCashGivenEmptyState"),table=el("adminCashGivenTable");\n' +
  '  tbody.innerHTML="";\n' +
  '  if(entries.length===0){empty.classList.remove("hidden");table.style.display="none";return;}\n' +
  '  empty.classList.add("hidden");table.style.display="";\n' +
  '  entries.forEach(function(e){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    tr.innerHTML="<td>"+esc(e.date)+"</td><td>"+esc(e.voucherNo)+"</td><td>Rs. "+e.amount.toLocaleString(\"en-IN\")+"</td>"+\n' +
  '      "<td><button class=\\"btn btn-outline btn-sm\\" data-cg-edit=\\""+esc(e.voucherNo)+"\\" data-cg-amt=\\""+e.amount+"\\">Edit</button> "+\n' +
  '      "<button class=\\"btn btn-danger btn-sm\\" data-cg-delete=\\""+esc(e.voucherNo)+"\\">Remove</button></td>";\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '  tbody.querySelectorAll("[data-cg-edit]").forEach(function(b){b.addEventListener("click",function(){openCashGivenEditModal(b.getAttribute("data-cg-edit"),b.getAttribute("data-cg-amt"));});});\n' +
  '  tbody.querySelectorAll("[data-cg-delete]").forEach(function(b){b.addEventListener("click",function(){deleteCashGivenEntry(b.getAttribute("data-cg-delete"));});});\n' +
  '}\n' +
  'function openCashGivenEditModal(voucherNo,currentAmount){\n' +
  '  _cashGivenEditTarget=voucherNo;\n' +
  '  el("adminCashGivenEditAmount").value=currentAmount;\n' +
  '  el("adminCashGivenEditAlert").className="alert";\n' +
  '  el("adminCashGivenEditModal").classList.add("show");\n' +
  '}\n' +
  'function confirmCashGivenEdit(){\n' +
  '  var amt=parseFloat(el("adminCashGivenEditAmount").value);\n' +
  '  if(!amt||amt<=0){showAlert("adminCashGivenEditAlert","error","Enter a valid amount.");return;}\n' +
  '  var btn=el("confirmCashGivenEditBtn");btn.disabled=true;btn.textContent="Saving...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Save";\n' +
  '      if(!r||!r.success){showAlert("adminCashGivenEditAlert","error",(r&&r.error)||"Failed to update.");return;}\n' +
  '      closeModal("adminCashGivenEditModal");\n' +
  '      showAlert("adminCashGivenAlert","success",r.message||"Entry updated.");\n' +
  '      fetchAdminCashGivenEntries();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Save";showAlert("adminCashGivenEditAlert","error","Server error: "+err);})\n' +
  '    .adminOverrideRdsCashGiven(_cashGivenEditTarget,amt,appToken);\n' +
  '}\n' +
  'function deleteCashGivenEntry(voucherNo){\n' +
  '  if(!confirm("Remove this Cash Given entry completely? This cannot be undone \\u2014 Accounts will need to re-enter the correct amount."))return;\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminCashGivenAlert","error",(r&&r.error)||"Failed to remove.");return;}\n' +
  '      showAlert("adminCashGivenAlert","success",r.message||"Entry removed.");\n' +
  '      fetchAdminCashGivenEntries();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminCashGivenAlert","error","Server error: "+err);})\n' +
  '    .adminRemoveRdsCashGiven(voucherNo,appToken);\n' +
  '}\n' +

  // Admin Cash Advances override (per explicit instruction) — mirrors
  // the Cash Given block immediately above, function for function.
  'var _cashAdvanceEditTarget=null;\n' +
  'function fetchAdminCashAdvances(){\n' +
  '  el("adminCashAdvancesAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminCashAdvancesAlert","error",(r&&r.error)||"Failed to load entries.");return;}\n' +
  '      renderAdminCashAdvancesTable(r.entries||[]);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminCashAdvancesAlert","error","Server error: "+err);})\n' +
  '    .getCashAdvanceEntries(appToken);\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success)return;\n' +
  '      var sel=el("adminCashAdvanceLedgerPerson");var current=sel.value;\n' +
  '      sel.innerHTML=\'<option value="">-- Select --</option>\';\n' +
  '      (r.persons||[]).forEach(function(name){var o=document.createElement("option");o.value=name;o.textContent=name;sel.appendChild(o);});\n' +
  '      if(current)sel.value=current;\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminCashAdvancesAlert","error","Server error: "+err);})\n' +
  '    .getCashAdvancePersons(appToken);\n' +
  '}\n' +
  'function renderAdminCashAdvancesTable(entries){\n' +
  '  var tbody=el("adminCashAdvancesBody"),empty=el("adminCashAdvancesEmptyState"),table=el("adminCashAdvancesTable");\n' +
  '  tbody.innerHTML="";\n' +
  '  if(entries.length===0){empty.classList.remove("hidden");table.style.display="none";return;}\n' +
  '  empty.classList.add("hidden");table.style.display="";\n' +
  '  entries.forEach(function(e){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    tr.innerHTML="<td>"+esc(e.dateGiven)+"</td><td>"+esc(stripIouPrefix(e.givenTo))+"</td><td>Rs. "+e.amount.toLocaleString(\"en-IN\")+"</td><td>"+esc(e.purpose)+"</td><td>"+esc(e.givenBy)+"</td>"+\n' +
  '      "<td><button class=\\"btn btn-outline btn-sm\\" data-ca-edit=\\""+esc(e.advanceId)+"\\" data-ca-amt=\\""+e.amount+"\\">Edit</button> "+\n' +
  '      "<button class=\\"btn btn-danger btn-sm\\" data-ca-delete=\\""+esc(e.advanceId)+"\\">Remove</button></td>";\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '  tbody.querySelectorAll("[data-ca-edit]").forEach(function(b){b.addEventListener("click",function(){openCashAdvanceEditModal(b.getAttribute("data-ca-edit"),b.getAttribute("data-ca-amt"));});});\n' +
  '  tbody.querySelectorAll("[data-ca-delete]").forEach(function(b){b.addEventListener("click",function(){deleteCashAdvanceEntry(b.getAttribute("data-ca-delete"));});});\n' +
  '}\n' +
  'function fetchAdminCashAdvanceLedger(){\n' +
  '  fetchCashAdvanceLedgerInto("adminCashAdvanceLedgerPerson","adminCashAdvanceLedgerTable","adminCashAdvanceLedgerBody","adminCashAdvanceLedgerEmpty","adminCashAdvancesAlert");\n' +
  '}\n' +
  'function openCashAdvanceEditModal(advanceId,currentAmount){\n' +
  '  _cashAdvanceEditTarget=advanceId;\n' +
  '  el("adminCashAdvanceEditAmount").value=currentAmount;\n' +
  '  el("adminCashAdvanceEditAlert").className="alert";\n' +
  '  el("adminCashAdvanceEditModal").classList.add("show");\n' +
  '}\n' +
  'function confirmCashAdvanceEdit(){\n' +
  '  var amt=parseFloat(el("adminCashAdvanceEditAmount").value);\n' +
  '  if(!amt||amt<=0){showAlert("adminCashAdvanceEditAlert","error","Enter a valid amount.");return;}\n' +
  '  var btn=el("confirmCashAdvanceEditBtn");btn.disabled=true;btn.textContent="Saving...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Save";\n' +
  '      if(!r||!r.success){showAlert("adminCashAdvanceEditAlert","error",(r&&r.error)||"Failed to update.");return;}\n' +
  '      closeModal("adminCashAdvanceEditModal");\n' +
  '      showAlert("adminCashAdvancesAlert","success",r.message||"Entry updated.");\n' +
  '      fetchAdminCashAdvances();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Save";showAlert("adminCashAdvanceEditAlert","error","Server error: "+err);})\n' +
  '    .adminEditCashAdvance(_cashAdvanceEditTarget,amt,appToken);\n' +
  '}\n' +
  'function deleteCashAdvanceEntry(advanceId){\n' +
  '  if(!confirm("Remove this Cash Advance entry completely? This cannot be undone."))return;\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminCashAdvancesAlert","error",(r&&r.error)||"Failed to remove.");return;}\n' +
  '      showAlert("adminCashAdvancesAlert","success",r.message||"Entry removed.");\n' +
  '      fetchAdminCashAdvances();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminCashAdvancesAlert","error","Server error: "+err);})\n' +
  '    .adminRemoveCashAdvance(advanceId,appToken);\n' +
  '}\n' +

  // ==========================================================================
  // ADMIN — CASH WITHDRAWAL DECISIONS. Records L2's email reply against a
  // Pending request. Approve/Reject use prompt() for the notes field,
  // same lightweight pattern this app already uses for password reset /
  // email-change prompts (see adminResetPassword etc.) rather than a new
  // modal for a two-field form.
  // ==========================================================================
  'function fetchAdminCashWithdrawals(){\n' +
  '  el("adminCashWithdrawalsAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminCashWithdrawalsAlert","error",(r&&r.error)||"Failed to load requests.");return;}\n' +
  '      renderAdminCashWithdrawalsTable(r.requests||[]);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminCashWithdrawalsAlert","error","Server error: "+err);})\n' +
  '    .getCashWithdrawalBatchesLog(appToken);\n' +
  '}\n' +
  'var CW_ADMIN_STATUS_COLORS={"Pending L2 Approval":"#C9915C","Approved":"#1F5B45","Rejected":"#C95C5C"};\n' +
  'function renderAdminCashWithdrawalsTable(requests){\n' +
  '  var tbody=el("adminCashWithdrawalsBody"),empty=el("adminCashWithdrawalsEmptyState"),table=el("adminCashWithdrawalsTable");\n' +
  '  tbody.innerHTML="";\n' +
  '  if(requests.length===0){empty.classList.remove("hidden");table.style.display="none";return;}\n' +
  '  empty.classList.add("hidden");table.style.display="";\n' +
  '  requests.forEach(function(r){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    var color=CW_ADMIN_STATUS_COLORS[r.status]||"#454B6B";\n' +
  '    var statusHtml=\'<span style="color:\'+color+\';font-weight:600;">\'+esc(r.status)+\'</span>\';\n' +
  '    if(r.status!=="Pending L2 Approval"&&r.decidedBy)statusHtml+=\'<div style="font-size:12px;color:#5F6684;">by \'+esc(r.decidedBy)+\' on \'+esc(r.decidedDate)+(r.decisionNotes?": "+esc(r.decisionNotes):"")+\'</div>\';\n' +
  '    var actionHtml=r.status==="Pending L2 Approval"\n' +
  '      ?\'<button class="btn btn-primary btn-sm" data-cw-approve="\'+esc(r.withdrawalId)+\'" style="margin-bottom:4px;">Approve</button> \'+\n' +
  '       \'<button class="btn btn-danger btn-sm" data-cw-reject="\'+esc(r.withdrawalId)+\'">Reject</button>\'\n' +
  '      :(r.excelUrl?\'<a href="\'+esc(r.excelUrl)+\'" target="_blank" style="font-size:13px;">View sheet</a>\':"");\n' +
  '    tr.innerHTML="<td>"+esc(r.withdrawalId)+"</td><td>"+esc(r.requestedDate)+"</td><td>"+esc(r.batchIds)+"</td><td>"+esc(r.periodFrom)+" to "+esc(r.periodTo)+"</td><td>Rs. "+r.totalAmount.toLocaleString("en-IN")+"</td><td>"+statusHtml+"</td><td>"+actionHtml+"</td>";\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '  tbody.querySelectorAll("[data-cw-approve]").forEach(function(b){b.addEventListener("click",function(){decideAdminCashWithdrawal(b.getAttribute("data-cw-approve"),"Approved");});});\n' +
  '  tbody.querySelectorAll("[data-cw-reject]").forEach(function(b){b.addEventListener("click",function(){decideAdminCashWithdrawal(b.getAttribute("data-cw-reject"),"Rejected");});});\n' +
  '}\n' +
  'function decideAdminCashWithdrawal(withdrawalId,decision){\n' +
  '  var promptLabel=decision==="Approved"?"Notes (optional) \\u2014 e.g. reference from L2\'s email reply:":"Reason for rejecting (visible in the audit trail):";\n' +
  '  var notes=prompt(promptLabel,"");\n' +
  '  if(notes===null)return;\n' +
  '  if(decision==="Rejected"&&!confirm("Reject "+withdrawalId+"? Every voucher in it becomes eligible for a new request again."))return;\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminCashWithdrawalsAlert","error",(r&&r.error)||"Failed to record decision.");return;}\n' +
  '      showAlert("adminCashWithdrawalsAlert","success",r.message||"Decision recorded.");\n' +
  '      fetchAdminCashWithdrawals();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminCashWithdrawalsAlert","error","Server error: "+err);})\n' +
  '    .decideCashWithdrawalBatch(withdrawalId,decision,notes,appToken);\n' +
  '}\n' +

  // ==========================================================================
  // L2 \u2014 CASH WITHDRAWAL APPROVAL (16 Sep 2026, per explicit instruction).
  // L2 decides in the app instead of replying to the request email and
  // waiting for Admin to transcribe it. Reads the same
  // getCashWithdrawalBatchesLog RPC the admin tab uses (L2 was already an
  // allowed reader) and calls the same decideCashWithdrawalBatch RPC, now
  // role-gated to L2 as well as admin.
  //
  // Concurrency, client half: with 2-3 L2 approvers the real defence is the
  // server-side script lock + Pending guard, which is authoritative. These
  // two client behaviours only keep the UI honest around it \u2014 every button
  // in the panel is disabled for the duration of the round trip (so one
  // approver cannot double-fire their own click), and EVERY outcome,
  // success or failure, ends in a refetch, so a colleague's decision lands
  // on screen the moment it is known rather than leaving a stale Approve
  // button sitting there.
  // ==========================================================================
  'var CW_L2_STATUS_COLORS={"Pending L2 Approval":"#C9915C","Approved":"#1F5B45","Rejected":"#C95C5C"};\n' +
  'function fetchL2WithdrawalRequests(){\n' +
  '  el("l2WithdrawalStatusText").textContent="Loading...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){el("l2WithdrawalStatusText").textContent=(r&&r.error)||"Could not load requests.";el("l2WithdrawalList").innerHTML="";return;}\n' +
  '      renderL2WithdrawalRequests(r.requests||[]);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){el("l2WithdrawalStatusText").textContent="Server error: "+err;})\n' +
  '    .getCashWithdrawalBatchesLog(appToken);\n' +
  '}\n' +
  'function renderL2WithdrawalRequests(requests){\n' +
  '  var pending=[],decided=[];\n' +
  '  requests.forEach(function(r){(r.status==="Pending L2 Approval"?pending:decided).push(r);});\n' +
  '  el("l2WithdrawalStatusText").textContent=pending.length===0?"Nothing is waiting for your approval right now.":pending.length+" request(s) waiting for your approval.";\n' +
  '  el("l2WithdrawalList").innerHTML=pending.map(function(r){\n' +
  '    return "<div style=\\"padding:10px 12px;border:1px solid #ECEEFB;border-radius:8px;margin-bottom:8px;background:#FFFFFF;\\">"+\n' +
  '      "<div style=\\"font-weight:600;color:#14173F;\\">"+esc(r.withdrawalId)+" \\u2014 Rs. "+r.totalAmount.toLocaleString("en-IN")+"</div>"+\n' +
  '      "<div style=\\"font-size:13px;color:#454B6B;margin-top:2px;\\">Batch(es): "+esc(r.batchIds)+" &nbsp;|&nbsp; Period: "+esc(r.periodFrom)+" to "+esc(r.periodTo)+" &nbsp;|&nbsp; "+r.voucherCount+" voucher(s)</div>"+\n' +
  '      "<div style=\\"font-size:12px;color:#5F6684;margin-top:2px;\\">Requested by "+esc(r.requestedBy)+" on "+esc(r.requestedDate)+"</div>"+\n' +
  '      "<div style=\\"margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;\\">"+\n' +
  '      (r.excelUrl?"<a href=\\""+esc(r.excelUrl)+"\\" target=\\"_blank\\" style=\\"font-size:13px;\\">View sheet</a>":"")+\n' +
  '      "<button class=\\"btn btn-primary btn-sm\\" data-l2cw-approve=\\""+esc(r.withdrawalId)+"\\" style=\\"width:auto;\\">Approve</button>"+\n' +
  '      "<button class=\\"btn btn-danger btn-sm\\" data-l2cw-reject=\\""+esc(r.withdrawalId)+"\\" style=\\"width:auto;\\">Reject</button>"+\n' +
  '      "</div></div>";\n' +
  '  }).join("");\n' +
  '  el("l2WithdrawalHistory").innerHTML=decided.length===0?"No decisions recorded yet.":decided.slice(0,5).map(function(r){\n' +
  '    var c=CW_L2_STATUS_COLORS[r.status]||"#454B6B";\n' +
  '    return "<div style=\\"margin-bottom:4px;\\">"+esc(r.withdrawalId)+" \\u2014 <span style=\\"color:"+c+";font-weight:600;\\">"+esc(r.status)+"</span> by "+esc(r.decidedBy||"-")+" on "+esc(r.decidedDate||"-")+(r.decisionNotes?": "+esc(r.decisionNotes):"")+"</div>";\n' +
  '  }).join("");\n' +
  '  el("l2WithdrawalList").querySelectorAll("[data-l2cw-approve]").forEach(function(b){b.addEventListener("click",function(){decideL2Withdrawal(b.getAttribute("data-l2cw-approve"),"Approved");});});\n' +
  '  el("l2WithdrawalList").querySelectorAll("[data-l2cw-reject]").forEach(function(b){b.addEventListener("click",function(){decideL2Withdrawal(b.getAttribute("data-l2cw-reject"),"Rejected");});});\n' +
  '}\n' +
  'function setL2WithdrawalButtonsDisabled(disabled){\n' +
  '  el("l2WithdrawalList").querySelectorAll("button").forEach(function(b){b.disabled=disabled;});\n' +
  '}\n' +
  'function decideL2Withdrawal(withdrawalId,decision){\n' +
  '  var approving=decision==="Approved";\n' +
  '  var notes=prompt(approving?"Notes (optional) \\u2014 reference or remark to include in the Accounts email:":"Reason for rejecting (goes into the Accounts email and the audit trail):","");\n' +
  '  if(notes===null)return;\n' +
  '  if(!approving&&!notes.replace(/^\\s+|\\s+$/g,"")){setInlineAlert("l2WithdrawalAlert","error","A rejection needs a reason.");return;}\n' +
  '  if(!confirm((approving?"Approve ":"Reject ")+withdrawalId+"? Accounts is emailed immediately and this cannot be undone."))return;\n' +
  '  setL2WithdrawalButtonsDisabled(true);\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){setInlineAlert("l2WithdrawalAlert","error",(r&&r.error)||"Failed to record decision.");fetchL2WithdrawalRequests();return;}\n' +
  '      setInlineAlert("l2WithdrawalAlert","success",r.message||"Decision recorded.");\n' +
  '      fetchL2WithdrawalRequests();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){setInlineAlert("l2WithdrawalAlert","error","Server error: "+err+" \\u2014 refresh before retrying; the decision may already have gone through.");fetchL2WithdrawalRequests();})\n' +
  '    .decideCashWithdrawalBatch(withdrawalId,decision,notes,appToken);\n' +
  '}\n' +

  'var _tallyVouchers=[],_tallyMode="pending";\n' +
  'function loadTallyExportPage(){\n' +
  '  el("tallyResults").className="hidden";\n' +
  // Tally Export is reachable from the sidebar by both accounts and admin
  // (see the sidebar's data-roles="accounts,admin" item).
  '  switchTallyMode("pending");\n' +
  '  showPage("tallyExportPage");\n' +
  '}\n' +

  // Pending Export (default, unchanged behavior) vs Already Exported —\n' +
  // both roles can VIEW either mode, but only admin actually gets\n' +
  // action controls (checkboxes + Generate/Re-Export button) in Exported\n' +
  // mode; accounts sees it strictly read-only, matching the server-side\n' +
  // permission enforced in generateTallyExport.\n' +
  'function switchTallyMode(mode){\n' +
  '  _tallyMode=mode;\n' +
  // FIXED: currentTallyFilters (batch/date/search) previously carried
  // over silently across Pending <-> Already Exported switches. A
  // filter applied while reviewing Pending (e.g. today\'s batch) would
  // stay active in Exported mode, hiding every older exported voucher
  // and making it look like only recently-exported ones existed.\n' +
  '  clearFilterInputs("tally");currentTallyFilters={};\n' +
  '  document.querySelectorAll("#tallyModeBtns .filter-btn").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-tally-mode")===mode);});\n' +
  '  var canAct=(mode==="pending")||(mode==="exported"&&appRole==="admin");\n' +
  '  el("tallySelectAllWrap").style.display=canAct?"":"none";\n' +
  '  el("tallySelectionSummary").style.display=canAct?"":"none";\n' +
  '  el("tallyModeHint").innerHTML=mode==="pending"?\n' +
  '    "Showing <strong>Approved</strong> vouchers not yet exported to Tally. Select the ones to export \u2014 one voucher, a batch, or a range all work the same way.":\n' +
  '    (appRole==="admin"?\n' +
  '      "Showing <strong>already-exported</strong> Approved vouchers \u2014 for reference, or to re-export (e.g. a lost/corrupted file). Re-exporting produces a NEW file; only use it to recover, not to re-import into Tally a second time.":\n' +
  '      "Showing <strong>already-exported</strong> Approved vouchers, for reference. Only admin can re-export.");\n' +
  '  el("tallyEmptyTitle").textContent=mode==="pending"?"No vouchers pending Tally export":"No already-exported vouchers found";\n' +
  '  fetchTallyVouchers();\n' +
  '}\n' +

  'function fetchTallyVouchers(){\n' +
  '  el("tallyAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("tallyAlert","error",(r&&r.error)||"Failed to load vouchers.");return;}\n' +
  '      _tallyVouchers=r.vouchers||[];\n' +
  '      populateBatchIdOptions("tally",_tallyVouchers);\n' +
  '      el("tallySelectAll").checked=false;\n' +
  '      renderTallyVouchers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("tallyAlert","error","Server error: "+err);})\n' +
  '    .getTallyExportCandidates(appToken,_tallyMode);\n' +
  '}\n' +

  'function renderTallyVouchers(){\n' +
  '  var tbody=el("tallyVouchersBody"),empty=el("tallyEmptyState"),table=el("tallyVouchersTable");\n' +
  '  tbody.innerHTML="";\n' +
  '  var list=_tallyVouchers.filter(function(v){return voucherMatchesFilters(v,currentTallyFilters);});\n' +
  '  list=sortVouchers(list,el("tallySortBy").value);\n' +
  '  var canAct=(_tallyMode==="pending")||(_tallyMode==="exported"&&appRole==="admin");\n' +
  '  if(list.length===0){\n' +
  // Same situation as Auditor: no all-encompassing status/mode value here
  // (_tallyMode is always "pending" or "exported", never "all"), so the
  // relevant filter concept is the bar criteria object. Clear action
  // reuses the page\'s real #tallyClearFilters button.
  '    var tallyFilterActive=Object.keys(currentTallyFilters||{}).some(function(k){return !!currentTallyFilters[k];});\n' +
  '    var tallyDefaultMsg=_tallyMode==="pending"?"No vouchers pending Tally export":"No already-exported vouchers found";\n' +
  '    setEmptyStateFilterInfo("tallyEmptyTitle","tallyEmptySub","tallyEmptyClearBtn",tallyDefaultMsg,tallyFilterActive?"your filters":null,function(){el("tallyClearFilters").click();});\n' +
  '    empty.classList.remove("hidden");table.style.display="none";updateTallyGenerateState();return;\n' +
  '  }\n' +
  '  empty.classList.add("hidden");table.style.display="";\n' +
  '  list.forEach(function(v){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    var checkboxCell=canAct?\'<input type="checkbox" class="tally-select" data-vid="\'+esc(v.voucherId)+\'">\':"";\n' +
  '    tr.innerHTML="<td>"+checkboxCell+"</td>"+\n' +
  '      "<td><strong>"+esc(v.voucherId)+"</strong></td><td>"+esc(v.date)+"</td><td>"+esc(stripIouPrefix(v.submittedBy))+"</td>"+\n' +
  '      "<td>"+esc(v.expenseType)+"</td><td><strong>Rs. "+v.amount.toLocaleString("en-IN")+"</strong></td><td>"+esc(v.batchId)+"</td>";\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '  tbody.querySelectorAll(".tally-select").forEach(function(cb){cb.addEventListener("change",updateTallyGenerateState);});\n' +
  '  updateTallyGenerateState();\n' +
  '}\n' +

  'function updateTallyGenerateState(){\n' +
  '  var checked=el("tallyVouchersBody").querySelectorAll(".tally-select:checked");\n' +
  '  var label=_tallyMode==="exported"?"Re-Export Selected":"Generate Tally Export for Selected";\n' +
  '  el("tallyGenerateBtn").disabled=checked.length===0;\n' +
  '  el("tallyGenerateBtn").textContent=checked.length>0?label+" ("+checked.length+")":label;\n' +
  // Sum recomputes from _tallyVouchers (already in the page, no new RPC)
  // on every checkbox toggle. The bar itself stays visible (governed by
  // canAct in switchTallyMode, same as tallySelectAllWrap) whether or not
  // anything is currently checked \u2014 only the sum text changes \u2014 so the
  // Generate button never disappears/reappears as someone checks boxes,
  // it just enables once the count is above zero.
  '  var sumText=el("tallySelectionSumText");\n' +
  '  if(checked.length===0){sumText.textContent="0 vouchers selected";return;}\n' +
  '  var total=0;\n' +
  '  checked.forEach(function(cb){\n' +
  '    var vid=cb.getAttribute("data-vid");\n' +
  '    var v=_tallyVouchers.find(function(x){return x.voucherId===vid;});\n' +
  '    if(v)total+=v.amount;\n' +
  '  });\n' +
  '  sumText.innerHTML=checked.length+(checked.length===1?" voucher":" vouchers")+" selected \\u00b7 total <strong>Rs. "+total.toLocaleString("en-IN")+"</strong>";\n' +
  '}\n' +

  'function runTallyExport(){\n' +
  '  var checked=Array.from(el("tallyVouchersBody").querySelectorAll(".tally-select:checked")).map(function(cb){return cb.getAttribute("data-vid");});\n' +
  '  if(checked.length===0)return;\n' +
  '  if(_tallyMode==="exported"&&!confirm("These vouchers were already exported once. Re-exporting creates a NEW file with new entries \u2014 only continue if you\'re recovering from a lost/corrupted file, not to re-import into Tally a second time. Continue?"))return;\n' +
  '  var btn=el("tallyGenerateBtn");btn.disabled=true;btn.textContent=_tallyMode==="exported"?"Re-exporting...":"Generating...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;\n' +
  '      if(!r||!r.success){updateTallyGenerateState();showAlert("tallyAlert","error",(r&&r.error)||"Export failed.");return;}\n' +
  '      var html="<strong>"+esc(r.message)+"</strong>";\n' +
  '      if(r.exportedFiles&&r.exportedFiles.length>0){\n' +
  '        html+=\'<div style="margin-top:12px;display:flex;flex-direction:column;gap:8px;">\';\n' +
  '        r.exportedFiles.forEach(function(f){\n' +
  '          html+=\'<a class="btn btn-primary btn-sm" style="width:auto;display:inline-block;text-decoration:none;" href="\'+encodeURI(f.url)+\'" target="_blank">&#x2B07; Download \'+esc(f.fileName)+"</a>";\n' +
  '        });\n' +
  '        html+="</div>";\n' +
  '      }\n' +
  '      if(r.skipped&&r.skipped.length>0){\n' +
  '        html+=\'<div style="margin-top:10px;font-size:14.5px;color:#8A5A17;">Skipped:<ul style="margin:6px 0 0 20px;">\';\n' +
  '        r.skipped.forEach(function(s){html+="<li>"+esc(s.voucherId)+" \u2014 "+esc(s.reason)+"</li>";});\n' +
  '        html+="</ul></div>";\n' +
  '      }\n' +
  '      el("tallyResults").className="";el("tallyResults").innerHTML=html;\n' +
  '      showAlert("tallyAlert","success","Export complete.");\n' +
  '      fetchTallyVouchers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;updateTallyGenerateState();showAlert("tallyAlert","error","Server error: "+err);})\n' +
  '    .generateTallyExport(JSON.stringify(checked),appToken);\n' +
  '}\n' +

  'function fetchAdminVendors(){\n' +
  '  el("adminAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to load vendors.");return;}\n' +
  '      _adminVendorsCache=r.vendors||[];\n' +
  '      renderAdminVendors(r.vendors);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .getAdminVendorList(appToken);\n' +
  '}\n' +

  'function renderAdminVendors(vendors){\n' +
  '  var tbody=el("vendorsBody"),empty=el("adminEmptyState"),table=el("vendorsTable");\n' +
  '  tbody.innerHTML="";\n' +
  '  if(!vendors||vendors.length===0){empty.classList.remove("hidden");table.style.display="none";return;}\n' +
  '  empty.classList.add("hidden");table.style.display="";\n' +
  '  vendors.forEach(function(v){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    var rateText=v.tdsApplicable?(v.tdsRate*100).toFixed(0)+"%":"\u2014";\n' +
  '    tr.innerHTML="<td>"+esc(v.name)+"</td><td>"+(v.tdsApplicable?"Yes":"No")+"</td><td>"+rateText+"</td>"+\n' +
  '      "<td>"+(v.pan?esc(v.pan):"\u2014")+"</td><td>"+(v.declarationOnFile?"Yes":"No")+"</td>"+\n' +
  '      "<td>Rs. "+(v.ledgerBalance||0).toLocaleString(\"en-IN\")+"</td>"+\n' +
  '      "<td><button class=\\"btn btn-outline btn-sm\\" data-edit-vendor=\\""+esc(v.name)+"\\">Edit</button></td>";\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '  tbody.querySelectorAll("[data-edit-vendor]").forEach(function(b){\n' +
  '    b.addEventListener("click",function(){\n' +
  '      var name=b.getAttribute("data-edit-vendor");\n' +
  '      var v=vendors.find(function(x){return x.name===name;});\n' +
  '      if(v)openEditVendorModal(v);\n' +
  '    });\n' +
  '  });\n' +
  '}\n' +

  // Client-side mirror of the server rule (getVendorsWithTDS/addVendor,
  // Master data.gs): a 194C declaration on file means TDS Not Applicable,
  // full stop — the Rate dropdown is locked and reset the moment the
  // checkbox is ticked, so the form never even LOOKS like it's asking
  // for a contradictory combination. The server enforces this
  // regardless of what the client sends, so this is purely UX clarity,
  // not the actual guarantee. Shared by both the Add Vendor form and the
  // Edit Vendor modal — pass which pair of field ids to sync.
  'function syncDeclarationFields(checkboxId,rateSelId){\n' +
  '  var declared=el(checkboxId).checked,rateSel=el(rateSelId);\n' +
  '  rateSel.disabled=declared;\n' +
  '  if(declared)rateSel.value="";\n' +
  '}\n' +
  'function syncVendorDeclarationFields(){syncDeclarationFields("newVendorDeclaration","newVendorTdsRate");}\n' +
  'function syncEditVendorDeclarationFields(){syncDeclarationFields("editVendorDeclaration","editVendorTdsRate");}\n' +

  'function addNewVendor(){\n' +
  '  var name=el("newVendorName").value.trim(),declaration=el("newVendorDeclaration").checked;\n' +
  '  var rateSel=declaration?"":el("newVendorTdsRate").value;\n' +
  '  var pan=el("newVendorPan").value.trim().toUpperCase();\n' +
  '  var ledgerBalance=el("newVendorLedgerBalance").value||0;\n' +
  '  if(!name){showAlert("adminAlert","error","Vendor name is required.");return;}\n' +
  '  var tdsApplicable=(rateSel!=="");\n' +
  '  var btn=el("adminAddVendorBtn");btn.disabled=true;btn.textContent="Adding...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Add Vendor";\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to add vendor.");return;}\n' +
  '      showAlert("adminAlert","success",r.message||"Vendor added.");\n' +
  '      el("newVendorName").value="";el("newVendorTdsRate").value="";el("newVendorPan").value="";el("newVendorDeclaration").checked=false;el("newVendorLedgerBalance").value="";\n' +
  '      syncVendorDeclarationFields();\n' +
  '      fetchAdminVendors();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Add Vendor";showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .addVendor(name,tdsApplicable,rateSel,pan,declaration,ledgerBalance,appToken);\n' +
  '}\n' +

  // Edit Vendor (master control) — this is the whole reason the "one
  // time setup" you don't want to redo by hand in the sheet works: every
  // field addVendor writes is also editable here, on an existing vendor,
  // through the same validated server path (updateVendorMasterData,
  // Master data.gs) rather than a raw sheet edit.
  'var _editVendorTarget=null;\n' +
  'function openEditVendorModal(v){\n' +
  '  _editVendorTarget=v.name;\n' +
  '  el("editVendorName").textContent=v.name;\n' +
  '  el("editVendorTdsRate").value=v.tdsApplicable?String(Math.round(v.tdsRate*100)):"";\n' +
  '  el("editVendorPan").value=v.pan||"";\n' +
  '  el("editVendorDeclaration").checked=!!v.declarationOnFile;\n' +
  '  el("editVendorLedgerBalance").value=v.ledgerBalance||0;\n' +
  '  syncEditVendorDeclarationFields();\n' +
  '  el("editVendorAlert").className="alert";\n' +
  '  el("editVendorModal").classList.add("show");\n' +
  '}\n' +
  'function confirmEditVendor(){\n' +
  '  var declaration=el("editVendorDeclaration").checked;\n' +
  '  var rateSel=declaration?"":el("editVendorTdsRate").value;\n' +
  '  var pan=el("editVendorPan").value.trim().toUpperCase();\n' +
  '  var ledgerBalance=el("editVendorLedgerBalance").value||0;\n' +
  '  var tdsApplicable=(rateSel!=="");\n' +
  '  var btn=el("confirmEditVendorBtn");btn.disabled=true;btn.textContent="Saving...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Save";\n' +
  '      if(!r||!r.success){showAlert("editVendorAlert","error",(r&&r.error)||"Failed to update vendor.");return;}\n' +
  '      closeModal("editVendorModal");\n' +
  '      showAlert("adminAlert","success",r.message||"Vendor updated.");\n' +
  '      fetchAdminVendors();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Save";showAlert("editVendorAlert","error","Server error: "+err);})\n' +
  '    .updateVendorMasterData(_editVendorTarget,tdsApplicable,rateSel,pan,declaration,ledgerBalance,appToken);\n' +
  '}\n' +

  // ==========================================================================
  // MANAGE USERS (Day 5) — admin CRUD for the 4 multi-user roles. Table
  // shows every user across all roles; each row gets Deactivate/Activate,
  // Reset Password, and Unlock (clears a lockout) actions.
  // ==========================================================================
  'var _adminUsers=[];\n' +
  'function fetchAdminUsers(){\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to load users.");return;}\n' +
  '      _adminUsers=r.users;\n' +
      '      if(typeof r.sessionRuleEnforced==="boolean")renderSessionRule(r.sessionRuleEnforced);\n' +
  '      renderAdminUsers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .listUsers(appToken);\n' +
  '}\n' +

  'function renderAdminUsers(){\n' +
  '  var tbody=el("usersBody"),empty=el("usersEmptyState"),table=el("usersTable");\n' +
  '  tbody.innerHTML="";\n' +
  '  if(_adminUsers.length===0){table.style.display="none";empty.classList.remove("hidden");return;}\n' +
  '  empty.classList.add("hidden");table.style.display="";\n' +
  '  _adminUsers.forEach(function(u){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    var statusBadge=u.active?\'<span class="badge badge-approved">Active</span>\':\'<span class="badge badge-rejected">Inactive</span>\';\n' +
'    if(u.sessionState==="online")statusBadge+=\' <span class="badge badge-approved user-session-chip" title="Logged in and active now">Online</span>\';\n' +
'    else if(u.sessionState==="idle")statusBadge+=\' <span class="badge badge-query user-session-chip" title="Logged in, but not seen recently - probably closed without logging out">Idle session</span>\';\n' +
  '    var btns=\'<div class="action-btns">\';\n' +
  '    btns+=\'<button class="btn btn-outline btn-sm" data-user-action="toggle" data-uid="\'+esc(u.userId)+\'" data-active="\'+u.active+\'">\'+(u.active?"Deactivate":"Activate")+\'</button>\';\n' +
  '    btns+=\'<button class="btn btn-outline btn-sm" data-user-action="reset" data-uid="\'+esc(u.userId)+\'" data-name="\'+esc(u.displayName)+\'">Reset Password</button>\';\n' +
  '    btns+=\'<button class="btn btn-outline btn-sm" data-user-action="position" data-uid="\'+esc(u.userId)+\'" data-name="\'+esc(u.displayName)+\'" data-position="\'+esc(u.designation)+\'">Edit Position</button>\';\n' +
  '    if(u.pendingEmail){\n' +
  '      btns+=\'<button class="btn btn-outline btn-sm" data-user-action="resendemail" data-uid="\'+esc(u.userId)+\'" data-email="\'+esc(u.pendingEmail)+\'">Resend Email</button>\';\n' +
  '      btns+=\'<button class="btn btn-outline btn-sm" data-user-action="cancelemail" data-uid="\'+esc(u.userId)+\'">Cancel Pending</button>\';\n' +
  '    }else{\n' +
  '      btns+=\'<button class="btn btn-outline btn-sm" data-user-action="email" data-uid="\'+esc(u.userId)+\'" data-name="\'+esc(u.displayName)+\'" data-position="\'+esc(u.designation)+\'" data-email="\'+esc(u.email)+\'">\'+(u.email?"Edit Email":"Set Email")+\'</button>\';\n' +
  '    }\n' +
  '    btns+=\'<button class="btn btn-outline btn-sm" data-user-action="unlock" data-uid="\'+esc(u.userId)+\'">Unlock</button>\';\n' +
'    btns+=\'<button class="btn btn-outline btn-sm" data-user-action="endsession" data-uid="\'+esc(u.userId)+\'" data-name="\'+esc(u.displayName)+\'" title="Logs this person out everywhere, even if the app cannot see their session">End session</button>\';\n' +
  '    btns+=\'</div>\';\n' +
  // A pending change shows as an amber note under the email cell rather
  // than replacing it \u2014 the OLD verified email (if any) stays visible
  // and in effect (item-15 notifications and notifyRole still use it)
  // right up until the new one is confirmed, so the admin can see both at
  // once instead of it looking like the email already changed.
  '    var posCell=(u.designation?\'<strong>\'+esc(u.designation)+\'</strong>\':\'<span style="color:#5F6684;">Not set</span>\')+\'<div style="font-size:12px;color:#5F6684;margin-top:2px;">App access: \'+esc(ROLE_LABELS[u.role]||u.role)+\'</div>\';\n' +
  '    var emailCell=(esc(u.email)||"\\u2014")+(u.pendingEmail?\'<div style="color:#C98A34;font-size:12.5px;margin-top:2px;">Waiting for \'+esc(u.pendingEmail)+\' to confirm (\'+pendingLeftText(u.pendingEmailMinutesLeft)+\')</div>\':"");\n' +
  '    tr.innerHTML="<td>"+esc(u.displayName)+"</td><td>"+esc(u.username)+"</td><td>"+posCell+"</td><td>"+emailCell+"</td><td>"+statusBadge+"</td><td>"+(esc(u.lastLogin)||"\\u2014")+"</td><td>"+btns+"</td>";\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '  var posSeen={};_adminUsers.forEach(function(u){if(u.designation)posSeen[u.designation]=1;});\n' +
  '  el("positionOptions").innerHTML=Object.keys(posSeen).sort().map(function(p){return \'<option value="\'+esc(p)+\'">\';}).join("");\n' +
  '  tbody.querySelectorAll("[data-user-action]").forEach(function(b){\n' +
  '    b.addEventListener("click",function(){\n' +
  '      var uid=b.getAttribute("data-uid"),action=b.getAttribute("data-user-action");\n' +
  '      if(action==="toggle"){\n' +
  '        var isActive=b.getAttribute("data-active")==="true";\n' +
  '        setUserActiveState(uid,!isActive);\n' +
  '      }else if(action==="reset"){\n' +
  '        var name=b.getAttribute("data-name");\n' +
  '        var pw=prompt("New password for "+name+" (min. 8 characters, 1 letter + 1 number):");\n' +
  '        if(pw)resetUserPasswordAction(uid,pw);\n' +
  '      }else if(action==="position"){\n' +
  '        var pname=b.getAttribute("data-name"),curPos=b.getAttribute("data-position")||"";\n' +
  '        var newPos=prompt("Position in the company for "+pname+" (e.g. Warehouse Manager). Shown instead of the app role. Leave blank to clear:",curPos);\n' +
  '        if(newPos!==null)setUserDesignationAction(uid,newPos.trim());\n' +
  '      }else if(action==="email"){\n' +
  '        var uname=b.getAttribute("data-name"),upos=b.getAttribute("data-position"),curEmail=b.getAttribute("data-email")||"";\n' +
  '        var newEmail=prompt("Email for "+uname+(upos?" ("+upos+")":"")+" (used for query reminders, blank to clear). The address owner gets an email with Yes / No buttons to confirm it:",curEmail);\n' +
  '        if(newEmail!==null)setUserEmailAction(uid,newEmail.trim());\n' +
  '      }else if(action==="resendemail"){\n' +
  '        setUserEmailAction(uid,b.getAttribute("data-email"));\n' +
  '      }else if(action==="cancelemail"){\n' +
  '        if(confirm("Cancel this pending email change?"))cancelPendingEmailAction(uid);\n' +
  '      }else if(action==="unlock"){\n' +
  '        unlockUserAction(uid);\n' +
'      }else if(action==="endsession"){\n' +
'        if(confirm("End the session of "+b.getAttribute("data-name")+" now? They will be logged out."))endUserSessionAction(uid);\n' +
  '      }\n' +
  '    });\n' +
  '  });\n' +
  '}\n' +

  'function addUser(){\n' +
  '  var displayName=el("newUserDisplayName").value.trim(),role=el("newUserRole").value,\n' +
  '      username=el("newUserUsername").value.trim(),password=el("newUserPassword").value,email=el("newUserEmail").value.trim(),designation=el("newUserDesignation").value.trim();\n' +
  '  if(!displayName||!role||!username||!password){showAlert("adminAlert","error","All fields are required to add a user.");return;}\n' +
  '  var btn=el("adminAddUserBtn");btn.disabled=true;btn.textContent="Adding...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Add User";\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to add user.");return;}\n' +
  '      showAlert("adminAlert","success",r.message||("User \\""+displayName+"\\" added."));\n' +
  '      el("newUserDisplayName").value="";el("newUserRole").value="";el("newUserUsername").value="";el("newUserPassword").value="";el("newUserEmail").value="";el("newUserDesignation").value="";\n' +
  '      fetchAdminUsers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Add User";showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .createUser(displayName,role,username,password,email,designation,appToken);\n' +
  '}\n' +

  'function pendingLeftText(minutes){\n' +
  '  var m=parseInt(minutes,10)||1;\n' +
  '  return (m>=90?Math.ceil(m/60)+"h":m+"m")+" left";\n' +
  '}\n' +
  // CHANGED (item 14): setUserEmail no longer finalizes a non-blank
  // address immediately \u2014 it emails the address a Yes / No confirmation
  // link, so the success message shows whatever the server says (either
  // "Email cleared." or "Confirmation email sent to ..."), rather than a
  // hardcoded "Email updated." "Resend Email" on a pending row calls this
  // again with the same pending address.
  'function setUserEmailAction(userId,email){\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to update email.");return;}\n' +
  '      showAlert("adminAlert","success",r.message||"Email updated.");\n' +
  '      fetchAdminUsers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .setUserEmail(userId,email,appToken);\n' +
  '}\n' +
  'function setUserDesignationAction(userId,designation){\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to update position.");return;}\n' +
  '      showAlert("adminAlert","success",r.message||"Position updated.");\n' +
  '      fetchAdminUsers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .setUserDesignation(userId,designation,appToken);\n' +
  '}\n' +
  'function cancelPendingEmailAction(userId){\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to cancel.");return;}\n' +
  '      showAlert("adminAlert","success",r.message||"Cancelled.");\n' +
  '      fetchAdminUsers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .cancelPendingEmailChange(userId,appToken);\n' +
  '}\n' +

  'function setUserActiveState(userId,active){\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to update user.");return;}\n' +
  '      showAlert("adminAlert","success",active?"User activated.":"User deactivated.");\n' +
  '      fetchAdminUsers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .setUserActive(userId,active,appToken);\n' +
  '}\n' +

  'function resetUserPasswordAction(userId,newPassword){\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to reset password.");return;}\n' +
  '      showAlert("adminAlert","success","Password reset. Share the new password with the user directly \\u2014 it will not be shown again here.");\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .resetUserPassword(userId,newPassword,appToken);\n' +
  '}\n' +

  'function unlockUserAction(userId){\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to unlock user.");return;}\n' +
  '      showAlert("adminAlert","success",r.message||"User unlocked.");\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .adminUnlockUser(userId,appToken);\n' +
  '}\n' +

'function endUserSessionAction(userId){\n' +
'  google.script.run\n' +
'    .withSuccessHandler(function(r){\n' +
'      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to end the session.");return;}\n' +
'      showAlert("adminAlert","success",r.message||"Session ended.");\n' +
'      fetchAdminUsers();\n' +
'    })\n' +
'    .withFailureHandler(function(err){showAlert("adminAlert","error","Server error: "+err);})\n' +
'    .adminEndUserSession(userId,appToken);\n' +
'}\n' +

  'function renderSessionRule(enforced){\n' +
  '  var b=el("adminToggleSessionRuleBtn");\n' +
  '  b.setAttribute("data-enforced",String(enforced));\n' +
  '  b.textContent=enforced?"Pause the one-login rule":"Turn the one-login rule back on";\n' +
  '  el("sessionRuleStatus").textContent=enforced?"One-login rule: ON. Each account can be logged in once at a time.":"One-login rule: PAUSED. Accounts can be logged in more than once until you turn it back on.";\n' +
  '}\n' +
  'function endAllSessionsAction(){\n' +
  '  if(!confirm("Log out every user right now? Anything they have not submitted or saved will be lost. Your own Admin session is not affected."))return;\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to end the sessions.");return;}\n' +
  '      showAlert("adminAlert","success",r.message||"All user sessions ended.");\n' +
  '      fetchAdminUsers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .adminEndAllSessions(appToken);\n' +
  '}\n' +
  'function toggleSessionRuleAction(){\n' +
  '  var enforced=el("adminToggleSessionRuleBtn").getAttribute("data-enforced")!=="false";\n' +
  '  var q=enforced?"Pause the one-login rule? Accounts will be able to log in more than once until you turn it back on.":"Turn the one-login rule back on?";\n' +
  '  if(!confirm(q))return;\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to change the setting.");return;}\n' +
  '      renderSessionRule(!!r.enforced);\n' +
  '      showAlert("adminAlert","success",r.message||"Saved.");\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .setSingleSessionEnforced(!enforced,appToken);\n' +
  '}\n' +

  'var _adminVouchers=[];\n' +
  'function fetchAdminVouchers(){\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to load vouchers.");return;}\n' +
  '      _adminVouchers=r.vouchers||[];\n' +
  '      populateBatchIdOptions("admin",_adminVouchers);\n' +
  '      renderAdminVouchers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .getAllVouchers(appToken);\n' +
  '}\n' +

  'function renderAdminVouchers(){\n' +
  '  var rows=_adminVouchers.filter(function(v){\n' +
  '    if(currentAdminStatusFilter!=="all"){\n' +
  '      if(currentAdminStatusFilter==="Query"){if(!(v.queryStatus&&v.queryStatus!=="No Query"))return false;}\n' +
  '      else if(v.status!==currentAdminStatusFilter)return false;\n' +
  '    }\n' +
  '    return voucherMatchesFilters(v,currentAdminFilters);\n' +
  '  });\n' +
  '  rows=sortVouchers(rows,el("adminSortBy").value);\n' +
  '  var tbody=el("adminVouchersBody"),empty=el("adminVouchersEmptyState"),table=el("adminVouchersTable");\n' +
  '  tbody.innerHTML="";\n' +
  '  if(rows.length===0){\n' +
  '    setEmptyStateFilterInfo("adminVouchersEmptyTitle","adminVouchersEmptySub","adminVouchersEmptyClearBtn","No vouchers found",currentAdminStatusFilter!=="all"?currentAdminStatusFilter:null,function(){document.querySelector(\'#adminVoucherStatusBtns [data-admin-status="all"]\').click();});\n' +
  '    empty.classList.remove("hidden");table.style.display="none";return;\n' +
  '  }\n' +
  '  empty.classList.add("hidden");table.style.display="";\n' +
  '  rows.forEach(function(v){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    var hasQuery=v.queryStatus&&v.queryStatus!=="No Query";\n' +
  '    tr.innerHTML="<td>"+statusChipHtml(v.status,false)+"</td><td>"+esc(v.voucherId)+"</td><td>"+esc(v.date)+"</td><td>"+esc(stripIouPrefix(v.submittedBy))+"</td>"+\n' +
  '      \'<td class="amt-cell">Rs. \'+v.amount.toLocaleString("en-IN")+"</td>"+\n' +
  '      "<td>"+(hasQuery?\'<span class="badge badge-query" title="\'+esc(v.queryStatus)+\'">Query</span>\':"\\u2014")+"</td>"+\n' +
  '      \'<td><div class="action-btns"><button class="btn btn-outline btn-sm" data-revert-vid="\'+esc(v.voucherId)+\'">Revert</button>\'+\n' +
  '      \'<button class="btn btn-outline btn-sm" data-changeid-vid="\'+esc(v.voucherId)+\'">Change ID</button>\'+\n' +
  '      \'<button class="btn btn-danger btn-sm" data-delete-vid="\'+esc(v.voucherId)+\'">Delete</button></div></td>\';\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '  tbody.querySelectorAll("[data-revert-vid]").forEach(function(b){\n' +
  '    b.addEventListener("click",function(){openRevertModal(b.getAttribute("data-revert-vid"));});\n' +
  '  });\n' +
  '  tbody.querySelectorAll("[data-changeid-vid]").forEach(function(b){\n' +
  '    b.addEventListener("click",function(){openChangeIdModal(b.getAttribute("data-changeid-vid"));});\n' +
  '  });\n' +
  '  tbody.querySelectorAll("[data-delete-vid]").forEach(function(b){\n' +
  '    b.addEventListener("click",function(){openDeleteVoucherModal(b.getAttribute("data-delete-vid"));});\n' +
  '  });\n' +
  '}\n' +

  'function openChangeIdModal(vid){\n' +
  '  el("changeIdOldVid").textContent=vid;\n' +
  '  el("changeIdNewVid").value="";\n' +
  '  el("changeIdReason").value="";\n' +
  '  el("changeIdAlert").className="alert";\n' +
  '  el("changeIdModal").classList.add("show");\n' +
  '}\n' +

  'function confirmChangeId(){\n' +
  '  var oldVid=el("changeIdOldVid").textContent,newVid=el("changeIdNewVid").value.trim(),reason=el("changeIdReason").value.trim();\n' +
  '  if(!newVid){setInlineAlert("changeIdAlert","error","New voucher ID is required.");return;}\n' +
  '  if(!reason){setInlineAlert("changeIdAlert","error","A reason is required.");return;}\n' +
  '  var btn=el("confirmChangeIdBtn");btn.disabled=true;btn.textContent="Changing...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Change ID";\n' +
  '      if(!r||!r.success){showAlert("changeIdAlert","error",(r&&r.error)||"Failed to change voucher ID.");return;}\n' +
  '      closeModal("changeIdModal");\n' +
  '      showAlert("adminAlert","success",r.message||"Voucher ID changed.");\n' +
  '      fetchAdminVouchers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Change ID";showAlert("changeIdAlert","error","Server error: "+err);})\n' +
  '    .adminChangeVoucherId(oldVid,newVid,reason,appToken);\n' +
  '}\n' +

  // Admin — complete voucher deletion (per explicit instruction). Two-step
  // confirm baked into ONE modal: a normal reason-required delete, which
  // escalates in place to a loud red warning state if the server reports
  // the voucher was already Tally-exported (requiresExportOverrideConfirm),
  // requiring a second click before it actually proceeds.
  '  var _deleteVoucherConfirmingExportOverride=false;\n' +
  'function openDeleteVoucherModal(vid){\n' +
  '  _deleteVoucherConfirmingExportOverride=false;\n' +
  '  el("deleteVoucherVid").textContent=vid;\n' +
  '  el("deleteVoucherConfirmIdHint").textContent=vid;\n' +
  '  el("deleteVoucherReason").value="";\n' +
  '  el("deleteVoucherConfirmId").value="";\n' +
  '  el("deleteVoucherAlert").className="alert";\n' +
  '  el("deleteVoucherExportWarning").classList.add("hidden");\n' +
  '  el("confirmDeleteVoucherBtn").textContent="Delete Voucher";\n' +
  '  el("confirmDeleteVoucherBtn").className="btn btn-danger";\n' +
  '  el("confirmDeleteVoucherBtn").disabled=true;\n' +
  '  el("deleteVoucherModal").classList.add("show");\n' +
  '}\n' +
  // Additional gate ahead of the existing button-click handler, not a
  // replacement for it \u2014 confirmDeleteVoucher()\'s own logic (reason
  // check, RPC call, export-override escalation) is untouched below.
  // Compares against deleteVoucherVid\'s live textContent, not a value
  // captured at modal-open time, so it still works correctly if that
  // element were ever updated after opening.
  'el("deleteVoucherConfirmId").addEventListener("input",function(){\n' +
  '  var typed=el("deleteVoucherConfirmId").value.trim();\n' +
  '  el("confirmDeleteVoucherBtn").disabled=(typed!==el("deleteVoucherVid").textContent);\n' +
  '});\n' +

  'function confirmDeleteVoucher(){\n' +
  '  var vid=el("deleteVoucherVid").textContent,reason=el("deleteVoucherReason").value.trim();\n' +
  '  if(!reason){setInlineAlert("deleteVoucherAlert","error","A reason is required.");return;}\n' +
  '  var btn=el("confirmDeleteVoucherBtn");btn.disabled=true;btn.textContent="Deleting...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;\n' +
  '      if(r&&r.requiresExportOverrideConfirm){\n' +
  // Escalate in place — don't close the modal, just switch it into the
  // loud warning state and require a second explicit click.
  '        _deleteVoucherConfirmingExportOverride=true;\n' +
  '        el("deleteVoucherExportWarning").classList.remove("hidden");\n' +
  '        el("deleteVoucherExportWarning").textContent=r.error;\n' +
  '        btn.textContent="Delete Anyway \\u2014 Already Exported";\n' +
  '        btn.className="btn btn-danger";\n' +
  '        return;\n' +
  '      }\n' +
  '      if(!r||!r.success){btn.textContent=_deleteVoucherConfirmingExportOverride?"Delete Anyway \\u2014 Already Exported":"Delete Voucher";setInlineAlert("deleteVoucherAlert","error",(r&&r.error)||"Failed to delete voucher.");return;}\n' +
  '      closeModal("deleteVoucherModal");\n' +
  '      showAlert("adminAlert","success",r.message||"Voucher deleted.");\n' +
  '      fetchAdminVouchers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Delete Voucher";setInlineAlert("deleteVoucherAlert","error","Server error: "+err);})\n' +
  '    .adminDeleteVoucherCompletely(vid,reason,_deleteVoucherConfirmingExportOverride,appToken);\n' +
  '}\n' +

  // Self-service password change — available on any multi-user-role
  // dashboard (My Vouchers header for submission, Approval Dashboard
  // header for L1/accounts/L2). Not offered for admin, which stays a
  // single shared PIN changed via the ADMIN_PIN Script Property.
  '  var _changePwReturnAlertId="submissionAlert";\n' +
  'function openChangePwModal(returnAlertId){\n' +
  '  _changePwReturnAlertId=returnAlertId||"submissionAlert";\n' +
  '  el("changePwOld").value="";el("changePwNew").value="";el("changePwConfirm").value="";\n' +
  '  el("changePwAlert").className="alert";\n' +
  '  el("changePwModal").classList.add("show");\n' +
  '}\n' +

  'function confirmChangePw(){\n' +
  '  var oldPw=el("changePwOld").value,newPw=el("changePwNew").value,confirmPw=el("changePwConfirm").value;\n' +
  '  if(!oldPw||!newPw||!confirmPw){setInlineAlert("changePwAlert","error","All fields are required.");return;}\n' +
  '  if(newPw!==confirmPw){setInlineAlert("changePwAlert","error","New password and confirmation don\\u2019t match.");return;}\n' +
  '  var btn=el("confirmChangePwBtn");btn.disabled=true;btn.textContent="Changing...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Change Password";\n' +
  '      if(!r||!r.success){showAlert("changePwAlert","error",(r&&r.error)||"Failed to change password.");return;}\n' +
  '      closeModal("changePwModal");\n' +
  '      showAlert(_changePwReturnAlertId,"success","Password changed successfully.");\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Change Password";showAlert("changePwAlert","error","Server error: "+err);})\n' +
  '    .changeOwnPassword(oldPw,newPw,appToken);\n' +
  '}\n' +

  'function openRevertModal(vid){\n' +
  '  var v=_adminVouchers.filter(function(x){return x.voucherId===vid;})[0];\n' +
  '  el("revertVid").textContent=vid;\n' +
  '  el("revertCurrentStatus").textContent=v?v.status:"";\n' +
  '  el("revertTargetStage").value="L1";\n' +
  '  el("revertReason").value="";\n' +
  '  el("revertModal").classList.add("show");\n' +
  '}\n' +

  'function confirmRevert(){\n' +
  '  var vid=el("revertVid").textContent,stage=el("revertTargetStage").value,reason=el("revertReason").value.trim();\n' +
  '  if(!reason){alert("A reason is required.");return;}\n' +
  '  var btn=el("confirmRevertBtn");btn.disabled=true;btn.textContent="Reverting...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Revert";\n' +
  '      closeModal("revertModal");\n' +
  '      if(!r||!r.success){showAlert("adminAlert","error",(r&&r.error)||"Failed to revert voucher.");return;}\n' +
  '      showAlert("adminAlert","success",r.message||"Voucher reverted.");\n' +
  '      fetchAdminVouchers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Revert";closeModal("revertModal");showAlert("adminAlert","error","Server error: "+err);})\n' +
  '    .adminRevertVoucher(vid,stage,reason,appToken);\n' +
  '}\n' +

  // Shared filter-matching logic — used by the Approval dashboard, Admin's
  // voucher table, and Tally Export's voucher selection. Reads raw input
  // values by id prefix and applies them as AND conditions (a voucher must
  // match every filled-in criterion, not any one of them).
  'function getFilterCriteria(prefix){\n' +
  '  return {\n' +
  '    dateFrom:el(prefix+"DateFrom").value,\n' +
  '    dateTo:el(prefix+"DateTo").value,\n' +
  '    batchId:el(prefix+"BatchId").value,\n' +
  '    voucherFrom:el(prefix+"VoucherFrom").value,\n' +
  '    voucherTo:el(prefix+"VoucherTo").value,\n' +
  '    voucherId:el(prefix+"VoucherId").value.trim(),\n' +
  '    search:el(prefix+"Search").value.trim().toLowerCase()\n' +
  '  };\n' +
  '}\n' +

  'function clearFilterInputs(prefix){\n' +
  '  ["DateFrom","DateTo","VoucherFrom","VoucherTo","VoucherId","Search"].forEach(function(suf){el(prefix+suf).value="";});\n' +
  '  el(prefix+"BatchId").value="";\n' +
  '  el(prefix+"SortBy").value="date_desc";\n' +
  '}\n' +

  // Shared empty-state helper (Fix J) — when a non-"all" filter is active,
  // names it in the message and shows a "Clear filter" button; otherwise
  // shows the page\'s normal default message with the button hidden.
  // resetFn is always a call into whatever reset path the page\'s own
  // "All"/"Clear filters" control already uses (a .click() on that real
  // button, in every case below) — never new reset logic of its own.
  //
  // filterLabel is either a real named filter value ("Rejected",
  // "Pending L1"...) for the 3 pages with a status-tab concept, or the
  // literal string "your filters" for Auditor/Tally (which only have
  // multi-field bar criteria, no single named value \u2014 see the render
  // functions below) \u2014 phrased differently since "No your filters
  // vouchers right now" doesn\'t read as a sentence.
  'function setEmptyStateFilterInfo(titleId,subId,clearBtnId,defaultTitle,filterLabel,resetFn){\n' +
  '  var titleEl=el(titleId),subEl=el(subId),btn=el(clearBtnId);\n' +
  '  if(filterLabel){\n' +
  '    if(filterLabel==="your filters"){\n' +
  '      titleEl.textContent="No vouchers match your filters";\n' +
  '      subEl.textContent="Try adjusting or clearing the filters above.";\n' +
  '    }else{\n' +
  '      titleEl.textContent="No "+filterLabel.toLowerCase()+" vouchers right now";\n' +
  '      subEl.textContent=\'Nothing matches the "\'+filterLabel+\'" filter you have active.\';\n' +
  '    }\n' +
  '    subEl.classList.remove("hidden");\n' +
  '    btn.classList.remove("hidden");\n' +
  '    btn.onclick=resetFn;\n' +
  '  }else{\n' +
  '    titleEl.textContent=defaultTitle;\n' +
  '    subEl.textContent="";\n' +
  '    subEl.classList.add("hidden");\n' +
  '    btn.classList.add("hidden");\n' +
  '    btn.onclick=null;\n' +
  '  }\n' +
  '}\n' +

  // Sort feature — applied independently of the Apply/Clear filter cycle
  // (fires immediately on change, like a live display-order preference
  // rather than a filter criterion). date_desc (newest first) is the
  // default, matching what every dashboard already effectively showed
  // before this existed (sheet append order is naturally oldest-to-newest,
  // so newest-first via explicit sort is the more useful default view).
  'function sortVouchers(list,sortBy){\n' +
  '  var sorted=list.slice();\n' +
  '  function dateVal(v){var d=parseDMY(v.date);return d?d.getTime():0;}\n' +
  '  function voucherNum(v){var n=parseInt(v.voucherId,10);return isNaN(n)?0:n;}\n' +
  '  switch(sortBy){\n' +
  '    case "date_asc": sorted.sort(function(a,b){return dateVal(a)-dateVal(b);}); break;\n' +
  '    case "amount_desc": sorted.sort(function(a,b){return b.amount-a.amount;}); break;\n' +
  '    case "amount_asc": sorted.sort(function(a,b){return a.amount-b.amount;}); break;\n' +
  '    case "voucher_desc": sorted.sort(function(a,b){return voucherNum(b)-voucherNum(a);}); break;\n' +
  '    case "voucher_asc": sorted.sort(function(a,b){return voucherNum(a)-voucherNum(b);}); break;\n' +
  '    default: sorted.sort(function(a,b){return dateVal(b)-dateVal(a);}); // date_desc\n' +
  '  }\n' +
  '  return sorted;\n' +
  '}\n' +

  // Batch ID dropdown options are derived from whatever voucher list was
  // just fetched, not a separate server round trip — same data the table
  // itself renders from. Re-populated on every fetch so a brand-new batch
  // shows up without a page reload; the currently-selected value is kept
  // if it's still a valid option.
  'function populateBatchIdOptions(prefix,vouchers){\n' +
  '  var sel=el(prefix+"BatchId"),current=sel.value;\n' +
  '  var seen={},batchIds=[];\n' +
  '  vouchers.forEach(function(v){if(v.batchId&&!seen[v.batchId]){seen[v.batchId]=true;batchIds.push(v.batchId);}});\n' +
  '  batchIds.sort().reverse();\n' +
  '  var html="<option value=\\"\\">All</option>";\n' +
  '  batchIds.forEach(function(b){html+=\'<option value="\'+esc(b)+\'">\'+esc(b)+\'</option>\';});\n' +
  '  sel.innerHTML=html;\n' +
  '  if(batchIds.indexOf(current)>=0)sel.value=current;\n' +
  '}\n' +

  // Voucher dates are stored/displayed as dd-MM-yyyy (see formatDate in
  // SheetUtils.gs) — not ISO, so date-range inputs (which give yyyy-mm-dd)
  // need explicit parsing rather than a straight Date() constructor call.
  // Accepts '/' too (tolerates a not-yet-migrated legacy value) so this
  // never silently breaks on old data mixed in with new hyphenated rows.
  'function parseDMY(str){\n' +
  '  if(!str)return null;\n' +
  '  var parts=str.split(/[\\/\\-]/);\n' +
  '  if(parts.length!==3)return null;\n' +
  '  var d=parseInt(parts[0],10),m=parseInt(parts[1],10)-1,y=parseInt(parts[2],10);\n' +
  '  var dt=new Date(y,m,d);\n' +
  '  return isNaN(dt.getTime())?null:dt;\n' +
  '}\n' +

  // Populates a native <input type="date"> from a LOCAL-time Date object
  // (e.g. one built by parseDMY, or plain `new Date()`) without going
  // through the element's own .valueAsDate setter. .valueAsDate reads/
  // writes via the Date object's UTC fields, not its local ones \u2014 for
  // any timezone AHEAD of UTC (India included: +5:30), a Date built via
  // `new Date(y,m,d)` at local midnight falls on the PREVIOUS day in UTC,
  // so `.valueAsDate=d` silently displays (and later reads back) one day
  // earlier than intended. This built and displayed the wrong date on
  // every edit-mode load, which is exactly what produced the resubmit's
  // "Date cannot be changed as part of a query response" error on every
  // single save \u2014 the form was never actually showing today\u2019s real
  // date to begin with, so submitting it unchanged still counted as a
  // change server-side. Setting .value directly with a plain "yyyy-mm-dd"
  // string sidesteps the UTC conversion entirely; the browser takes it
  // as-is with no timezone interpretation.
  'function setDateInputFromLocalDate(inputEl,d){\n' +
  '  inputEl.value=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");\n' +
  '}\n' +

  'function voucherMatchesFilters(v,f){\n' +
  '  if(!f)return true;\n' +
  '  if(f.dateFrom||f.dateTo){\n' +
  '    var vd=parseDMY(v.date);\n' +
  '    if(!vd)return false;\n' +
  '    if(f.dateFrom&&vd<new Date(f.dateFrom))return false;\n' +
  '    if(f.dateTo){var dt=new Date(f.dateTo);dt.setHours(23,59,59,999);if(vd>dt)return false;}\n' +
  '  }\n' +
  '  if(f.batchId&&v.batchId!==f.batchId)return false;\n' +
  '  if(f.voucherId&&v.voucherId!==f.voucherId)return false;\n' +
  '  if(f.voucherFrom||f.voucherTo){\n' +
  '    var vn=parseInt(v.voucherId,10);\n' +
  '    if(isNaN(vn))return false;\n' +
  '    if(f.voucherFrom&&vn<parseInt(f.voucherFrom,10))return false;\n' +
  '    if(f.voucherTo&&vn>parseInt(f.voucherTo,10))return false;\n' +
  '  }\n' +
  '  if(f.search){\n' +
  '    var hay=((v.voucherId||"")+" "+(v.submittedBy||"")+" "+(v.vehicleNo||"")+" "+(v.costCentre||"")+" "+(v.expenseType||"")).toLowerCase();\n' +
  '    if(hay.indexOf(f.search)<0)return false;\n' +
  '  }\n' +
  '  return true;\n' +
  '}\n' +

  'function fetchVouchers(){\n' +
  '  el("approvalAlert").className="alert";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("approvalAlert","error",(r&&r.error)||"Failed to load vouchers.");return;}\n' +
  '      allVouchers=r.vouchers;\n' +
  '      populateBatchIdOptions("appr",allVouchers);\n' +
  '      document.querySelectorAll("#filterBtns .filter-btn").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-filter")===currentFilter);});\n' +
  '      renderVouchers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("approvalAlert","error","Server error: "+err);})\n' +
  '    .getAllVouchers(appToken);\n' +
  '}\n' +

  'function renderVouchers(){\n' +
  '  var tbody=el("vouchersBody"),empty=el("emptyState"),table=el("vouchersTable");\n' +
  '  tbody.innerHTML="";\n' +
  '  var list=allVouchers.filter(function(v){\n' +
  '    if(currentFilter!=="all"){\n' +
  '      if(currentFilter==="Query"){if(!(v.queryStatus&&v.queryStatus!=="No Query"))return false;}\n' +
  '      else if(v.status!==currentFilter)return false;\n' +
  '    }\n' +
  '    return voucherMatchesFilters(v,currentApprFilters);\n' +
  '  });\n' +
  '  list=sortVouchers(list,el("apprSortBy").value);\n' +
  '  if(list.length===0){\n' +
  '    setEmptyStateFilterInfo("emptyStateTitle","emptyStateSub","emptyStateClearBtn","No vouchers found",currentFilter!=="all"?currentFilter:null,function(){document.querySelector(\'#filterBtns [data-filter="all"]\').click();});\n' +
  '    empty.classList.remove("hidden");table.style.display="none";return;\n' +
  '  }\n' +
  '  empty.classList.add("hidden");table.style.display="";\n' +
  '  list.forEach(function(v){\n' +
  '    var tr=document.createElement("tr");\n' +
  '    var pendingByRole={L1:"Pending L1",accounts:"Pending Accounts",L2:"Pending L2"};\n' +
  '    var canAct=pendingByRole[appRole]===v.status;\n' +
  '    var hasQuery=v.queryStatus&&v.queryStatus!=="No Query";\n' +
  '    var btns=\'<button class="btn btn-outline btn-sm" data-action="view" data-vid="\'+esc(v.voucherId)+\'">View</button>\';\n' +
  // CHANGED (bugfix round 2, #1): a queried voucher previously still
  // showed disabled "Approve (Query Open)" / "Reject (Query Open)"
  // buttons here — per explicit instruction, a queried (or rejected —
  // already excluded via canAct above, since Rejected isn\'t a
  // pendingByRole status) voucher should show NO action buttons at all
  // on any approval dashboard while it\'s locked; only View remains, and
  // only the submitter can act on it (edit if Rejected, respond if
  // queried). Server-side gating (updateVoucherStatus, Approval.gs)
  // already refuses both actions regardless of what\'s rendered here —
  // this only removes the dead buttons from the UI.
  '    if(canAct&&!hasQuery){\n' +
  '      btns+=\'<button class="btn btn-success btn-sm" data-action="approve" data-vid="\'+esc(v.voucherId)+\'">Approve</button>\';\n' +
  '      btns+=\'<button class="btn btn-danger btn-sm" data-action="reject" data-vid="\'+esc(v.voucherId)+\'">Reject</button>\';\n' +
  '      btns+=\'<button class="btn btn-warning btn-sm" data-action="query" data-vid="\'+esc(v.voucherId)+\'">Query</button>\';\n' +
  '    }\n' +
  // Not gated to canAct — GST can be entered/corrected any time before
  // Tally export, not just while the voucher is Pending Accounts. IS now
  // gated on !hasQuery, though (bugfix round 2, #1) — the query might be
  // exactly about the vendor/amount GST would be calculated against, so
  // GST entry is locked along with everything else until the submitter
  // resolves it.
  '    if(appRole==="accounts"&&v.expenseType==="Transport"&&!hasQuery){\n' +
  '      btns+=\'<button class="btn btn-outline btn-sm" data-action="gst" data-vid="\'+esc(v.voucherId)+\'">GST</button>\';\n' +
  '    }\n' +
  // Dual-GST vendor flow for Regular expenses (handoff 2.C) — same
  // not-gated-to-canAct / gated-on-!hasQuery posture as the Transport
  // GST button above, and same tallyExported guard the server enforces
  // (saveRegularVendorGst/clearRegularVendorGst, Approval.gs) — no client
  // check needed for that since the button simply won\'t be useful post-export,
  // the server will just refuse the save.
  '    if(appRole==="accounts"&&v.expenseType!=="Transport"&&!hasQuery){\n' +
  '      btns+=\'<button class="btn btn-outline btn-sm" data-action="regularvendor" data-vid="\'+esc(v.voucherId)+\'">Vendor GST</button>\';\n' +
  '    }\n' +
  '    tr.innerHTML=\'<td>\'+vdChainMiniHtml(v)+\'</td><td>\'+statusChipHtml(v.status,hasQuery)+\'</td>\'+\n' +
  '      "<td><strong>"+esc(v.voucherId)+"</strong></td><td>"+esc(v.date)+"</td><td>"+esc(stripIouPrefix(v.submittedBy))+"</td>"+\n' +
  '      "<td>"+esc(v.expenseType)+"</td>"+\n' +
  '      \'<td class="amt-cell">Rs. \'+v.amount.toLocaleString("en-IN")+"</td><td>"+esc(v.costCentre)+"</td>"+\n' +
  '      \'<td><div class="action-btns">\'+btns+\'</div></td>\';\n' +
  '    tbody.appendChild(tr);\n' +
  '  });\n' +
  '}\n' +

  // Approval-chain progress strip (#8) — 3 steps, each derived purely from
  // fields getAllVouchers already returns (approvedL1/Accounts/L2,
  // rejectedAtStage), no extra RPC needed.
  //
  // vdChainStates(v) is the shared state-determination logic, extracted
  // out so the mini 3-dot version used in table rows (vdChainMiniHtml)
  // doesn\'t reimplement the L1/Accounts/L2 state rules a second time —
  // vdChainHtml (the detail-modal renderer) is refactored to consume it
  // too, with its own HTML output unchanged. "current" (the stage this
  // voucher is presently sitting at, derived from v.status) is new state
  // this extraction surfaces — vdChainHtml itself still only visually
  // distinguishes done/rejected/waiting as before; only the new mini
  // renderer uses "current" for its extra visual state.
  'function vdChainStates(v){\n' +
  '  var l1Rej=v.status==="Rejected"&&v.rejectedAtStage==="L1";\n' +
  '  var accRej=v.status==="Rejected"&&v.rejectedAtStage==="accounts";\n' +
  '  var l2Rej=v.status==="Rejected"&&v.rejectedAtStage==="L2";\n' +
  '  var pendingLabel={"Pending L1":"L1","Pending Accounts":"Accounts","Pending L2":"L2"}[v.status]||null;\n' +
  '  return [\n' +
  '    {label:"L1",note:v.approvedL1,done:!!v.approvedL1,rejected:l1Rej,current:pendingLabel==="L1"},\n' +
  '    {label:"Accounts",note:v.approvedAccounts,done:!!v.approvedAccounts,rejected:accRej,current:pendingLabel==="Accounts"},\n' +
  '    {label:"L2",note:v.approvedL2,done:!!v.approvedL2,rejected:l2Rej,current:pendingLabel==="L2"}\n' +
  '  ];\n' +
  '}\n' +
  'function vdChainStep(label,approvedNote,isRejectedHere){\n' +
  '  var cls="waiting",mark="";\n' +
  '  if(isRejectedHere){cls="rejected";mark="\\u2715";}\n' +
  '  else if(approvedNote){cls="done";mark="\\u2713";}\n' +
  '  var sub=isRejectedHere?"Rejected here":(approvedNote?esc(approvedNote.split("(")[0].trim()):"");\n' +
  '  return \'<div class="vd-chain-step"><div class="vd-chain-dot \'+cls+\'">\'+mark+\'</div><div class="lbl">\'+esc(label)+\'</div><div class="sub">\'+sub+\'</div></div>\';\n' +
  '}\n' +
  'function vdChainHtml(v){\n' +
  '  var states=vdChainStates(v);\n' +
  '  var h=\'<div class="vd-chain">\';\n' +
  '  h+=vdChainStep(states[0].label,states[0].note,states[0].rejected);\n' +
  '  h+=\'<div class="vd-chain-line\'+(states[0].done?" done":"")+\'"></div>\';\n' +
  '  h+=vdChainStep(states[1].label,states[1].note,states[1].rejected);\n' +
  '  h+=\'<div class="vd-chain-line\'+(states[1].done?" done":"")+\'"></div>\';\n' +
  '  h+=vdChainStep(states[2].label,states[2].note,states[2].rejected);\n' +
  '  h+="</div>";\n' +
  '  return h;\n' +
  '}\n' +
  // Mini 3-dot version for table rows — same state rules as above (via
  // vdChainStates), new CSS classes only (.chain-mini, .chain-dot-mini),
  // does not touch .vd-chain* used by the detail modal.
  'function vdChainMiniHtml(v){\n' +
  '  var states=vdChainStates(v);\n' +
  '  return \'<div class="chain-mini">\'+states.map(function(s){\n' +
  '    var cls="waiting";\n' +
  '    if(s.rejected)cls="rejected";else if(s.done)cls="done";else if(s.current)cls="current";\n' +
  '    var title=s.label+(s.rejected?" \\u2014 Rejected":s.done?" \\u2014 Approved":s.current?" \\u2014 Pending":" \\u2014 Waiting");\n' +
  '    return \'<span class="chain-dot-mini \'+cls+\'" title="\'+esc(title)+\'"></span>\';\n' +
  '  }).join("")+"</div>";\n' +
  '}\n' +
  // Status "chip" (dot + label) for table rows — one shared component
  // across the 3 voucher tables, replacing the old plain .badge in the
  // Status column specifically. forceQueryLabel is only passed true on
  // the Approval table, which has no separate always-visible Query
  // column (it used to append a second badge inline instead) — My
  // Vouchers and Admin Vouchers keep their own dedicated Query column,
  // so their chip keeps showing the real underlying stage rather than
  // being overridden to "Query" (avoids showing "Query" twice).
  'function statusChipHtml(status,forceQueryLabel){\n' +
  '  var cls="st-l1",label=status;\n' +
  '  if(forceQueryLabel){cls="st-qry";label="Query";}\n' +
  '  else if(status==="Pending L1"){cls="st-l1";}\n' +
  '  else if(status==="Pending Accounts"){cls="st-acc";}\n' +
  '  else if(status==="Pending L2"){cls="st-l2";}\n' +
  '  else if(status==="Approved"){cls="st-app";}\n' +
  '  else if(status==="Rejected"){cls="st-rej";}\n' +
  '  return \'<span class="status-chip \'+cls+\'"><span class="status-dot"></span>\'+esc(label)+"</span>";\n' +
  '}\n' +

  // Bill chip click \u2014 opens the file immediately (window.open fires
  // synchronously, so there\'s no perceived delay) and fires the audit
  // record alongside it, never blocking on the RPC (#10).
  'function openBillFile(url,voucherId,label){\n' +
  '  window.open(url,"_blank");\n' +
  '  google.script.run.withFailureHandler(function(){}).logBillViewed(voucherId,label,appToken);\n' +
  '}\n' +
  'window.openBillFile=openBillFile;\n' +

  'function viewDetail(vid,list){\n' +
  '  list=list||allVouchers;\n' +
  '  var v=list.find(function(x){return x.voucherId===vid;});if(!v)return;\n' +
  '  var badge="badge-pending";\n' +
  '  if(v.status==="Approved")badge="badge-approved";else if(v.status==="Rejected")badge="badge-rejected";\n' +
  '  var h=\'<div class="vd-header"><div><h3>Voucher \'+esc(v.voucherId)+\'</h3><div class="sub">\'+esc(stripIouPrefix(v.submittedBy))+\' \\u00b7 \'+esc(v.expenseType)+\'</div></div>\'+\n' +
  '    \'<span class="badge \'+badge+\'">\'+esc(v.status)+\'</span></div>\';\n' +
  '  h+=\'<div class="vd-stats">\'+\n' +
  '    \'<div class="vd-stat"><div class="lbl">Amount</div><div class="val">Rs. \'+v.amount.toLocaleString("en-IN")+\'</div></div>\'+\n' +
  '    \'<div class="vd-stat"><div class="lbl">Cost centre</div><div class="val">\'+esc(v.costCentre)+\'</div></div>\'+\n' +
  '    \'<div class="vd-stat"><div class="lbl">Batch</div><div class="val">\'+esc(v.batchId||"\\u2014")+\'</div></div></div>\';\n' +
  '  h+=vdChainHtml(v);\n' +
  '  h+=\'<div id="vdQuerySlot"></div>\';\n' +
  '  h+=\'<div class="vd-section">\';\n' +
  '  var rows=[["Voucher Date",v.date],["Actual Expense Date",v.actualExpenseDate||v.date],["Vehicle No.",v.vehicleNo||"\\u2014"],["Notes",v.notes||"\\u2014"],["Cash Released",v.cashReleased?"Yes":"No"]];\n' +
  '  if(v.editLockedBy)rows.push(["Currently Locked",v.editLockedBy+" is editing this voucher"]);\n' +
  '  rows.forEach(function(r){h+=\'<div class="vd-row"><div class="k">\'+esc(r[0])+\'</div><div class="v">\'+esc(String(r[1]))+"</div></div>";});\n' +
  '  if(v.billFiles){\n' +
  '    var urls=v.billFiles.split("\\n").map(function(u){return u.trim();}).filter(Boolean);\n' +
  '    h+=\'<div class="vd-row" style="align-items:flex-start;"><div class="k">Bills</div><div class="v"><div class="vd-bills">\'+\n' +
  '      urls.map(function(u,i){return \'<button class="vd-bill-chip" data-bill-idx="\'+i+\'">\\uD83D\\uDCC4 Bill \'+(i+1)+"</button>";}).join("")+\n' +
  '      "</div></div></div>";\n' +
  '  }\n' +
  '  h+="</div>";\n' +
  '  el("detailContent").innerHTML=h;\n' +
  // Bill chips are bound via addEventListener with the URL passed as a
  // captured variable, not serialized into an inline onclick string —
  // urls[] comes straight from DriveApp.getUrl() server-side (never
  // free-form user text), so this was never live-exploitable, but this
  // removes the injection surface structurally instead of just escaping
  // it, since an inline-onclick string is a meaningfully riskier pattern
  // (inline-script injection) than an href/attribute interpolation.
  '  if(v.billFiles){\n' +
  '    document.querySelectorAll("#detailContent .vd-bill-chip").forEach(function(btn){\n' +
  '      var idx=parseInt(btn.getAttribute("data-bill-idx"),10);\n' +
  '      btn.addEventListener("click",function(){openBillFile(urls[idx],v.voucherId,"Bill "+(idx+1));});\n' +
  '    });\n' +
  '  }\n' +
  '  el("detailModal").classList.add("show");\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success||!r.query){el("vdQuerySlot").innerHTML="";return;}\n' +
  '      var q=r.query,isOpen=(q.status==="Open");\n' +
  '      var qh=\'<div class="vd-query-block"><div class="qhead">\'+(isOpen?"Open query":"Query")+\' \\u2014 \'+esc(q.queryType)+\'</div>\';\n' +
  '      qh+=\'<div class="qtext">"\'+esc(q.queryDetails)+\'" \\u2014 \'+esc(q.raisedBy)+", "+esc(q.raisedDate)+"</div>";\n' +
  '      if(q.response){\n' +
  '        qh+=\'<div class="vd-response"><span class="meta">Response \\u00b7 \'+esc(q.responseDate)+\'</span>"\'+esc(q.response)+\'"</div>\';\n' +
  '      }\n' +
  '      qh+="</div>";\n' +
  '      el("vdQuerySlot").innerHTML=qh;\n' +
  '    })\n' +
  '    .withFailureHandler(function(){el("vdQuerySlot").innerHTML="";})\n' +
  '    .getLatestQueryThreadForVoucher(vid,appToken);\n' +
  '}\n' +

  'function openApprove(vid){currentVoucherId=vid;el("approveVid").textContent=vid;el("approveNotes").value="";el("approveModal").classList.add("show");}\n' +
  'function openReject(vid){currentVoucherId=vid;el("rejectVid").textContent=vid;el("rejectReason").value="";el("rejectModal").classList.add("show");}\n' +
  'var QUERY_LINE_TARGET_CATEGORIES=["Amount","Ledger / Vendor"];\n' +
  'var _queryLineItemsCache=null;\n' +
  'function openQuery(vid){currentVoucherId=vid;el("queryVid").textContent=vid;el("queryType").value="Bill Files";el("queryDetails").value="";_queryLineItemsCache=null;refreshQueryLinePicker();el("queryModal").classList.add("show");}\n' +
  'function refreshQueryLinePicker(){\n' +
  '  var qtype=el("queryType").value,group=el("queryLinePickerGroup"),list=el("queryLinePickerList");\n' +
  '  var v=allVouchers.find(function(x){return x.voucherId===currentVoucherId;});\n' +
  '  var isTransportV=v&&v.expenseType==="Transport";\n' +
  '  var descOpt=el("queryType").querySelector(\'option[value="Description"]\');\n' +
  '  if(descOpt)descOpt.disabled=isTransportV;\n' +
  '  if(isTransportV&&qtype==="Description"){el("queryType").value="Other";qtype="Other";}\n' +
  '  var needsLines=QUERY_LINE_TARGET_CATEGORIES.indexOf(qtype)!==-1&&isTransportV;\n' +
  '  if(!needsLines){group.classList.add("hidden");return;}\n' +
  '  group.classList.remove("hidden");\n' +
  '  list.innerHTML="Loading vendor lines...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){list.innerHTML="Could not load vendor lines.";return;}\n' +
  '      _queryLineItemsCache=r.items;\n' +
  '      list.innerHTML=r.items.map(function(it){\n' +
  // Bordered, full-row-clickable items — the checkbox itself keeps its
  // exact class (query-line-check, required by refreshQueryLinePicker\'s
  // caller at line ~3338 above) and value attribute (lineIndex) unchanged.
  // "Full row clickable" is achieved by wrapping the checkbox in a real
  // <label> rather than a custom click listener \u2014 a label natively
  // toggles its wrapped checkbox and fires a genuine change event on
  // click, which is more robust than reimplementing that behavior in JS,
  // and nothing currently listens for a change event on .query-line-check
  // (confirmed) so no dispatch step is needed either way.
  '        return \'<label class="line-pick-item"><input type="checkbox" class="query-line-check line-pick-check" value="\'+it.lineIndex+\'"><span class="line-pick-vendor">\'+esc(it.vendorName)+\'</span><span class="line-pick-amount">Rs. \'+it.amount.toLocaleString("en-IN")+"</span></label>";\n' +
  '      }).join("");\n' +
  // Checked-row highlight (matches the checked/unchecked visual state
  // shown in the mock) \u2014 additive to the native label/checkbox
  // behavior above, not a replacement for it.
  '      list.querySelectorAll(".query-line-check").forEach(function(cb){\n' +
  '        cb.addEventListener("change",function(){cb.closest(".line-pick-item").classList.toggle("checked",cb.checked);});\n' +
  '      });\n' +
  '    })\n' +
  '    .withFailureHandler(function(){list.innerHTML="Could not load vendor lines.";})\n' +
  '    .getVendorLineItems(currentVoucherId,appToken);\n' +
  '}\n' +

  'function submitApproval(){\n' +
  '  var btn=el("confirmApproveBtn"),notes=el("approveNotes").value.trim();\n' +
  '  btn.disabled=true;btn.textContent="Approving...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Approve";\n' +
  '      closeModal("approveModal");\n' +
  '      if(!r||!r.success){showAlert("approvalAlert","error",(r&&r.error)||"Failed.");return;}\n' +
  '      showAlert("approvalAlert","success",r.message);\n' +
  '      fetchVouchers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(e){\n' +
  '      btn.disabled=false;btn.textContent="Approve";\n' +
  '      closeModal("approveModal");\n' +
  '      showAlert("approvalAlert","error","Error: "+e);\n' +
  '    })\n' +
  '    .updateVoucherStatus(currentVoucherId,"approve",notes,appToken);\n' +
  '}\n' +

  'function submitRejection(){\n' +
  '  var btn=el("confirmRejectBtn"),reason=el("rejectReason").value.trim();\n' +
  '  if(!reason){showAlert("approvalAlert","error","Please provide a rejection reason.");return;}\n' +
  '  btn.disabled=true;btn.textContent="Rejecting...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Reject";\n' +
  '      closeModal("rejectModal");\n' +
  '      if(!r||!r.success){showAlert("approvalAlert","error",(r&&r.error)||"Failed.");return;}\n' +
  '      showAlert("approvalAlert","success",r.message);\n' +
  '      fetchVouchers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(e){\n' +
  '      btn.disabled=false;btn.textContent="Reject";\n' +
  '      closeModal("rejectModal");\n' +
  '      showAlert("approvalAlert","error","Error: "+e);\n' +
  '    })\n' +
  '    .updateVoucherStatus(currentVoucherId,"reject",reason,appToken);\n' +
  '}\n' +

  'function submitQuery(){\n' +
  '  var btn=el("confirmQueryBtn"),qtype=el("queryType").value,qdet=el("queryDetails").value.trim();\n' +
  '  if(!qdet){showAlert("approvalAlert","error","Please enter query details.");return;}\n' +
  '  var lineIndexes=[];\n' +
  '  if(!el("queryLinePickerGroup").classList.contains("hidden")){\n' +
  '    document.querySelectorAll(".query-line-check:checked").forEach(function(cb){lineIndexes.push(parseInt(cb.value,10));});\n' +
  '    if(lineIndexes.length===0){showAlert("approvalAlert","error","Select at least one vendor line this query applies to.");return;}\n' +
  '  }\n' +
  '  btn.disabled=true;btn.textContent="Raising...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Raise Query";\n' +
  '      closeModal("queryModal");\n' +
  '      if(!r||!r.success){showAlert("approvalAlert","error",(r&&r.error)||"Failed.");return;}\n' +
  '      showAlert("approvalAlert","success",r.message);\n' +
  '      fetchVouchers();\n' +
  '    })\n' +
  '    .withFailureHandler(function(e){\n' +
  '      btn.disabled=false;btn.textContent="Raise Query";\n' +
  '      closeModal("queryModal");\n' +
  '      showAlert("approvalAlert","error","Error: "+e);\n' +
  '    })\n' +
  '    .raiseVoucherQuery(currentVoucherId,qtype,qdet,JSON.stringify(lineIndexes),appToken);\n' +
  '}\n' +

  'var _gstItems=[];\n' +
  'function openGstModal(vid){\n' +
  '  currentVoucherId=vid;\n' +
  '  el("gstVid").textContent=vid;\n' +
  '  el("gstAlert").className="alert";\n' +
  '  el("gstLineItems").innerHTML="Loading...";\n' +
  '  el("gstModal").classList.add("show");\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){el("gstLineItems").innerHTML="";showAlert("gstAlert","error",(r&&r.error)||"Failed to load vendor line items.");return;}\n' +
  '      _gstItems=r.items;\n' +
  '      renderGstLineItems();\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){el("gstLineItems").innerHTML="";showAlert("gstAlert","error","Server error: "+err);})\n' +
  '    .getVendorLineItems(vid,appToken);\n' +
  '}\n' +

  'function renderGstLineItems(){\n' +
  '  var c=el("gstLineItems");c.innerHTML="";\n' +
  '  _gstItems.forEach(function(it){\n' +
  '    var row=document.createElement("div");\n' +
  '    row.className="gst-line-row";row.setAttribute("data-line-index",it.lineIndex);row.setAttribute("data-amount",it.amount);\n' +
  '    row.innerHTML=\'<div class="gst-line-head"><span>\'+esc(it.vendorName)+\' \u2014 Rs. \'+it.amount.toLocaleString("en-IN")+\'</span><span class="gst-status-tag"></span></div>\'+\n' +
  '      \'<div class="gst-line-toggle">\'+\n' +
  '        \'<button type="button" class="gst-toggle-btn" data-toggle="yes">GST Applied</button>\'+\n' +
  '        \'<button type="button" class="gst-toggle-btn" data-toggle="no">No GST</button>\'+\n' +
  '      \'</div>\'+\n' +
  // Hamali (loading/unloading charges) — per your correction, gated
  // behind the GST toggle same as CGST/SGST: only enterable/visible when
  // a line is marked "GST Applied", hidden and cleared to 0 on "No GST".
  '      \'<div class="gst-line-fields hidden"><div class="form-group"><label>CGST (Rs.)</label><input type="number" class="gst-cgst" min="0" step="0.01" value="\'+(it.cgst||"")+\'"></div>\'+\n' +
  '      \'<div class="form-group"><label>SGST (Rs.)</label><input type="number" class="gst-sgst" min="0" step="0.01" value="\'+(it.sgst||"")+\'"></div>\'+\n' +
  '      \'<div class="form-group"><label>Hamali (Rs.)</label><input type="number" class="gst-hamali" min="0" step="0.01" value="\'+(it.hamali||"")+\'" placeholder="0.00"></div>\'+\n' +
  '      \'<div class="form-group" style="grid-column:1 / -1;"><label>LR No. <span class="req">*</span></label><input type="text" class="gst-lrno" value="\'+esc(it.lrNo||"")+\'" placeholder="LR number as on the bill"></div></div>\'+\n' +
  '      \'<div class="gst-base-readout"></div>\';\n' +
  '    c.appendChild(row);\n' +
  '    // Pre-existing reviewed state seeds the toggle; a never-reviewed line\n' +
  '    // starts with NEITHER button selected, forcing an explicit choice.\n' +
  '    if(it.gstReviewed){\n' +
  '      setGstToggle(row,(it.cgst>0||it.sgst>0)?"yes":"no",true);\n' +
  '    }else{\n' +
  '      row.setAttribute("data-resolved","0");\n' +
  '      updateGstStatusTag(row);\n' +
  '      updateGstBaseReadout(row);\n' +
  '    }\n' +
  '    row.querySelectorAll(".gst-toggle-btn").forEach(function(btn){\n' +
  '      btn.addEventListener("click",function(){setGstToggle(row,btn.getAttribute("data-toggle"),false);});\n' +
  '    });\n' +
  '    row.querySelector(".gst-cgst").addEventListener("input",function(){\n' +
  // CGST = SGST for standard intra-state GST — auto-mirror as a
  // convenience default. Only fires on the user actually typing (this
  // listener, not the initial value="..." attribute set at render time),
  // so a pre-existing GST-reviewed voucher with genuinely different
  // CGST/SGST loads untouched. SGST stays independently editable
  // afterward — this only pre-fills it, it doesn\'t lock it.
  '      row.querySelector(".gst-sgst").value=this.value;\n' +
  '      updateGstBaseReadout(row);\n' +
  '    });\n' +
  '    row.querySelector(".gst-sgst").addEventListener("input",function(){updateGstBaseReadout(row);});\n' +
  '    row.querySelector(".gst-hamali").addEventListener("input",function(){updateGstBaseReadout(row);});\n' +
  '  });\n' +
  '  refreshGstSaveState();\n' +
  '}\n' +

  // choice: "yes"/"no". fromServer=true means this is seeding the initial
  // state from a previously-reviewed line, not a fresh user click.
  'function setGstToggle(row,choice,fromServer){\n' +
  '  row.setAttribute("data-selected",choice);\n' +
  '  row.setAttribute("data-resolved","1");\n' +
  '  row.querySelectorAll(".gst-toggle-btn").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-toggle")===choice);});\n' +
  '  var fields=row.querySelector(".gst-line-fields");\n' +
  '  if(choice==="yes"){\n' +
  '    fields.classList.remove("hidden");\n' +
  '  }else{\n' +
  '    fields.classList.add("hidden");\n' +
  '    row.querySelector(".gst-cgst").value="0";row.querySelector(".gst-sgst").value="0";row.querySelector(".gst-hamali").value="0";row.querySelector(".gst-lrno").value="";\n' +
  '  }\n' +
  '  updateGstBaseReadout(row);\n' +
  '  updateGstStatusTag(row);\n' +
  '  if(!fromServer)refreshGstSaveState();\n' +
  '}\n' +

  // Bulk "Mark All No GST" (handoff 2.A) — pre-fills every vendor line on
  // this voucher to the No-GST reviewed state in one click. Deliberately
  // routes through the exact same setGstToggle() every individual click
  // uses — no separate/shortcut code path — so every line still ends up
  // in the normal per-line reviewed state, and the actual write to the
  // sheet still only happens when Accounts hits the ordinary "Save GST"
  // button afterward (this button touches nothing server-side by itself).
  // Any line can still be flipped back to "GST Applied" individually
  // before saving.
  'function bulkMarkNoGst(){\n' +
  '  var rows=el("gstLineItems").querySelectorAll(".gst-line-row");\n' +
  '  rows.forEach(function(row){setGstToggle(row,"no",false);});\n' +
  '}\n' +

  'function updateGstStatusTag(row){\n' +
  '  var tag=row.querySelector(".gst-status-tag");\n' +
  '  var reviewed=row.getAttribute("data-resolved")==="1";\n' +
  '  row.classList.toggle("gst-row-reviewed",reviewed);\n' +
  '  row.classList.toggle("gst-row-unreviewed",!reviewed);\n' +
  '  if(reviewed){\n' +
  '    tag.className="gst-status-tag gst-reviewed-tag";tag.textContent="Reviewed";\n' +
  '  }else{\n' +
  '    tag.className="gst-status-tag gst-unreviewed-tag";tag.textContent="Select Yes/No";\n' +
  '  }\n' +
  '}\n' +

  // Save is disabled until every line has an explicit Yes/No selection —
  // either from this session or a prior review. This is what forces the
  // "open it, mark No" step for genuinely GST-free bills instead of letting
  // a line sit at its untouched default forever.
  'function refreshGstSaveState(){\n' +
  '  var rows=el("gstLineItems").querySelectorAll(".gst-line-row");\n' +
  '  var allResolved=true;\n' +
  '  rows.forEach(function(row){if(row.getAttribute("data-resolved")!=="1")allResolved=false;});\n' +
  '  var btn=el("confirmGstBtn");\n' +
  '  btn.disabled=!allResolved;\n' +
  '  el("gstAlert").className="alert";\n' +
  '  if(!allResolved)setInlineAlert("gstAlert","error","Select Yes or No for every vendor before saving.");\n' +
  '}\n' +

  'function updateGstBaseReadout(row){\n' +
  '  var amount=parseFloat(row.getAttribute("data-amount"))||0;\n' +
  '  var cgst=parseFloat(row.querySelector(".gst-cgst").value)||0;\n' +
  '  var sgst=parseFloat(row.querySelector(".gst-sgst").value)||0;\n' +
  '  var hamali=parseFloat(row.querySelector(".gst-hamali").value)||0;\n' +
  '  var base=amount-cgst-sgst-hamali;\n' +
  '  var readout=row.querySelector(".gst-base-readout");\n' +
  '  if(base<-0.01){\n' +
  '    readout.textContent="CGST + SGST + Hamali exceeds the bill amount (Rs. "+amount.toLocaleString("en-IN")+") \u2014 not saveable.";\n' +
  '    readout.classList.add("negative");\n' +
  '  }else{\n' +
  '    readout.textContent="Base amount (before GST/Hamali): Rs. "+base.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});\n' +
  '    readout.classList.remove("negative");\n' +
  '  }\n' +
  '}\n' +

  'function saveGst(){\n' +
  '  var btn=el("confirmGstBtn"),rows=el("gstLineItems").querySelectorAll(".gst-line-row"),payload=[],ok=true,errMsg="";\n' +
  '  rows.forEach(function(row){\n' +
  '    if(row.getAttribute("data-resolved")!=="1"){ok=false;errMsg="Select Yes or No for every vendor before saving.";return;}\n' +
  '    var idx=parseInt(row.getAttribute("data-line-index"),10);\n' +
  '    var amount=parseFloat(row.getAttribute("data-amount"))||0;\n' +
  '    var selected=row.getAttribute("data-selected");\n' +
  '    var cgst=selected==="yes"?parseFloat(row.querySelector(".gst-cgst").value):0;\n' +
  '    var sgst=selected==="yes"?parseFloat(row.querySelector(".gst-sgst").value):0;\n' +
  '    var hamali=selected==="yes"?parseFloat(row.querySelector(".gst-hamali").value):0;\n' +
  '    var lrNo=selected==="yes"?row.querySelector(".gst-lrno").value.trim():"";\n' +
  '    if(isNaN(cgst)||cgst<0||isNaN(sgst)||sgst<0||isNaN(hamali)||hamali<0){ok=false;errMsg="CGST, SGST, and Hamali must be numbers of 0 or more.";return;}\n' +
  '    if(cgst+sgst+hamali>amount+0.01){ok=false;errMsg="CGST + SGST + Hamali cannot exceed the bill amount for one or more vendors \u2014 these are part of the total, not added on top.";return;}\n' +
  '    if((cgst+sgst)>0&&!lrNo){ok=false;errMsg="LR number is required for every vendor with GST applied.";return;}\n' +
  '    payload.push({lineIndex:idx,cgst:cgst,sgst:sgst,hamali:hamali,lrNo:lrNo});\n' +
  '  });\n' +
  '  if(!ok){showAlert("gstAlert","error",errMsg);return;}\n' +
  '  if(payload.length===0){showAlert("gstAlert","error","No vendor line items to save.");return;}\n' +
  '  btn.disabled=true;btn.textContent="Saving...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Save GST";\n' +
  '      if(!r||!r.success){showAlert("gstAlert","error",(r&&r.error)||"Failed to save GST.");return;}\n' +
  '      closeModal("gstModal");\n' +
  '      showAlert("approvalAlert","success",r.message);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Save GST";showAlert("gstAlert","error","Server error: "+err);})\n' +
  '    .updateVendorLineItemGst(currentVoucherId,JSON.stringify(payload),appToken);\n' +
  '}\n' +

  // Dual-GST vendor flow for Regular expenses (handoff 2.C) — client
  // side. Fetches existing routing state (if any) plus the vendor list
  // in one call (getRegularVendorGstForVoucher, Approval.gs), seeds the
  // toggle/fields from it, and saves via the server RPC saveRegularVendorGst
  // or clears via clearRegularVendorGst depending on the toggle's final
  // state — mirrors gstModal's open/save shape but without any per-line
  // list, LR number, or TDS math (none of those apply to this flow).
  // NOTE: this client function is named saveRegularVendorGstClick, NOT
  // saveRegularVendorGst, to avoid shadowing the server RPC of the same
  // name that google.script.run calls below — a same-named client
  // function would silently intercept that call.
  'function openRegularVendorModal(vid){\n' +
  '  currentVoucherId=vid;\n' +
  '  el("regularVendorVid").textContent=vid;\n' +
  '  el("regularVendorAlert").className="alert";\n' +
  '  el("regularVendorToggle").checked=false;\n' +
  '  el("regularVendorFields").classList.add("hidden");\n' +
  '  el("regularVendorName").innerHTML=\'<option value="">-- Select vendor --</option>\';\n' +
  '  el("regularVendorCgst").value="";el("regularVendorSgst").value="";\n' +
  '  el("regularVendorModal").classList.add("show");\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      if(!r||!r.success){showAlert("regularVendorAlert","error",(r&&r.error)||"Failed to load vendor GST.");return;}\n' +
  '      (r.vendors||[]).forEach(function(name){\n' +
  '        var opt=document.createElement("option");opt.value=name;opt.textContent=name;\n' +
  '        el("regularVendorName").appendChild(opt);\n' +
  '      });\n' +
  '      if(r.existing){\n' +
  '        el("regularVendorToggle").checked=true;\n' +
  '        el("regularVendorFields").classList.remove("hidden");\n' +
  '        el("regularVendorName").value=r.existing.vendorName;\n' +
  '        el("regularVendorCgst").value=r.existing.cgst||"";\n' +
  '        el("regularVendorSgst").value=r.existing.sgst||"";\n' +
  '        updateRegularVendorBaseReadout();\n' +
  '      }\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){showAlert("regularVendorAlert","error","Server error: "+err);})\n' +
  '    .getRegularVendorGstForVoucher(vid,appToken);\n' +
  '}\n' +
  'function updateRegularVendorBaseReadout(){\n' +
  '  var v=allVouchers.find(function(x){return x.voucherId===currentVoucherId;});\n' +
  '  var amount=v?v.amount:0;\n' +
  '  var cgst=parseFloat(el("regularVendorCgst").value)||0;\n' +
  '  var sgst=parseFloat(el("regularVendorSgst").value)||0;\n' +
  '  var base=amount-cgst-sgst;\n' +
  '  var readout=el("regularVendorBaseReadout");\n' +
  '  if(base<-0.01){\n' +
  '    readout.textContent="CGST + SGST exceeds the voucher amount (Rs. "+amount.toLocaleString("en-IN")+") \\u2014 not saveable.";\n' +
  '    readout.style.color="#C95C5C";\n' +
  '  }else{\n' +
  '    readout.textContent="Base amount (before GST): Rs. "+base.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});\n' +
  '    readout.style.color="#454B6B";\n' +
  '  }\n' +
  '}\n' +
  'function saveRegularVendorGstClick(){\n' +
  '  var btn=el("confirmRegularVendorBtn"),vid=currentVoucherId;\n' +
  '  if(!el("regularVendorToggle").checked){\n' +
  '    btn.disabled=true;btn.textContent="Saving...";\n' +
  '    google.script.run\n' +
  '      .withSuccessHandler(function(r){\n' +
  '        btn.disabled=false;btn.textContent="Save";\n' +
  '        if(!r||!r.success){showAlert("regularVendorAlert","error",(r&&r.error)||"Failed to save.");return;}\n' +
  '        closeModal("regularVendorModal");\n' +
  '        showAlert("approvalAlert","success",r.message);\n' +
  '      })\n' +
  '      .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Save";showAlert("regularVendorAlert","error","Server error: "+err);})\n' +
  '      .clearRegularVendorGst(vid,appToken);\n' +
  '    return;\n' +
  '  }\n' +
  '  var vendorName=el("regularVendorName").value;\n' +
  '  var cgst=parseFloat(el("regularVendorCgst").value)||0;\n' +
  '  var sgst=parseFloat(el("regularVendorSgst").value)||0;\n' +
  '  if(!vendorName){showAlert("regularVendorAlert","error","Select a vendor.");return;}\n' +
  '  if(isNaN(cgst)||cgst<0||isNaN(sgst)||sgst<0){showAlert("regularVendorAlert","error","CGST and SGST must be numbers of 0 or more.");return;}\n' +
  '  btn.disabled=true;btn.textContent="Saving...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Save";\n' +
  '      if(!r||!r.success){showAlert("regularVendorAlert","error",(r&&r.error)||"Failed to save.");return;}\n' +
  '      closeModal("regularVendorModal");\n' +
  '      showAlert("approvalAlert","success",r.message);\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Save";showAlert("regularVendorAlert","error","Server error: "+err);})\n' +
  '    .saveRegularVendorGst(vid,vendorName,cgst,sgst,appToken);\n' +
  '}\n' +
  'el("regularVendorToggle").addEventListener("change",function(){\n' +
  '  el("regularVendorFields").classList.toggle("hidden",!this.checked);\n' +
  '});\n' +
  'el("regularVendorCgst").addEventListener("input",function(){\n' +
  // CGST = SGST for standard intra-state GST — same auto-mirror
  // convenience default Transport's vendor GST entry already has (see
  // the .gst-cgst listener above). Only fires on the user typing, not on
  // the r.existing.cgst load above, so a pre-existing GST-reviewed
  // voucher with genuinely different CGST/SGST loads untouched. SGST
  // stays independently editable afterward — this only pre-fills it.
  '  el("regularVendorSgst").value=this.value;\n' +
  '  updateRegularVendorBaseReadout();\n' +
  '});\n' +
  'el("regularVendorSgst").addEventListener("input",updateRegularVendorBaseReadout);\n' +
  'el("cancelRegularVendorBtn").addEventListener("click",function(){closeModal("regularVendorModal");});\n' +
  'el("confirmRegularVendorBtn").addEventListener("click",saveRegularVendorGstClick);\n' +
  'el("regularNoGstBtn").addEventListener("click",function(){\n' +
  '  el("regularVendorToggle").checked=false;\n' +
  '  el("regularVendorFields").classList.add("hidden");\n' +
  '  saveRegularVendorGstClick();\n' +
  '});\n' +

  // Event listeners
  'el("loginBtn").addEventListener("click",doLogin);\n' +
  'el("loginUsername").addEventListener("keydown",function(e){if(e.key==="Enter")el("loginPassword").focus();});\n' +
  'el("loginPassword").addEventListener("keydown",function(e){if(e.key==="Enter")doLogin();});\n' +
'(function(){var pw=el("loginPassword"),hint=el("loginCaps");\n' +
'  function caps(e){hint.classList.toggle("hidden",!(e.getModifierState&&e.getModifierState("CapsLock")));}\n' +
'  pw.addEventListener("keydown",caps);pw.addEventListener("keyup",caps);\n' +
'  pw.addEventListener("blur",function(){hint.classList.add("hidden");});\n' +
'})();\n' +
  'el("successLogoutBtn").addEventListener("click",requestLogout);\n' +
  'el("sbLogoutBtn").addEventListener("click",requestLogout);\n' +
  'el("sbChangePwBtn").addEventListener("click",function(){\n' +
  '  var p=document.querySelector(".page.active");\n' +
  '  openChangePwModal(p&&PAGE_ALERT_MAP[p.id]);\n' +
  '});\n' +
  'el("adminRefreshBtn").addEventListener("click",fetchAdminVendors);\n' +
  // Duplicate vendor name check — case-insensitive, trimmed, checked
  // against the vendor list already cached from the last fetchAdminVendors
  // success handler (no new RPC). Warning is advisory only; the server
  // (addVendor) remains the real gate against actual duplicates.
  'el("newVendorName").addEventListener("input",function(){\n' +
  '  var rawTyped=el("newVendorName").value.trim();\n' +
  '  var typed=rawTyped.toLowerCase();\n' +
  '  var dup=typed&&_adminVendorsCache.some(function(v){return String(v.name||"").trim().toLowerCase()===typed;});\n' +
  '  var warn=el("newVendorDupWarning");\n' +
  '  warn.classList.toggle("hidden",!dup);\n' +
  '  warn.classList.toggle("exists",!!dup);\n' +
  '  if(dup)warn.textContent="\\u26A0 A vendor named \\""+rawTyped+"\\" is already registered \\u2014 check the list below before adding a duplicate.";\n' +
  '});\n' +
  'document.querySelectorAll("#adminTabBtns .admin-nav-tab").forEach(function(btn){\n' +
  '  btn.addEventListener("click",function(){var t=btn.getAttribute("data-admin-tab");switchAdminTab(t);if(t==="cashgiven")fetchAdminCashGivenEntries();if(t==="cashadvances")fetchAdminCashAdvances();if(t==="cashwithdrawals")fetchAdminCashWithdrawals();});\n' +
  '});\n' +
  'el("vendorListToggleBtn").addEventListener("click",function(){\n' +
  '  var wrap=el("vendorListWrap"),nowHidden=wrap.classList.toggle("hidden");\n' +
  '  this.innerHTML=nowHidden?"&#x25BC; Show Registered Vendors":"&#x25B2; Hide Registered Vendors";\n' +
  '});\n' +
  'el("adminAddVendorBtn").addEventListener("click",addNewVendor);\n' +
'el("newVendorDeclaration").addEventListener("change",syncVendorDeclarationFields);\n' +
'el("editVendorDeclaration").addEventListener("change",syncEditVendorDeclarationFields);\n' +
'el("cancelEditVendorBtn").addEventListener("click",function(){closeModal("editVendorModal");});\n' +
'el("confirmEditVendorBtn").addEventListener("click",confirmEditVendor);\n' +
  'el("adminAddUserBtn").addEventListener("click",addUser);\n' +
  'el("adminEndAllSessionsBtn").addEventListener("click",endAllSessionsAction);\n' +
  'el("adminToggleSessionRuleBtn").addEventListener("click",toggleSessionRuleAction);\n' +
  'el("adminRepairTriggersBtn").addEventListener("click",function(){\n' +
  '  var btn=el("adminRepairTriggersBtn");btn.disabled=true;btn.textContent="Reinstalling...";\n' +
  '  google.script.run\n' +
  '    .withSuccessHandler(function(r){\n' +
  '      btn.disabled=false;btn.textContent="Reinstall Scheduled Reminders";\n' +
  '      if(!r||!r.success){setInlineAlert("adminRepairTriggersAlert","error",(r&&r.error)||"Failed to reinstall triggers.");return;}\n' +
  '      setInlineAlert("adminRepairTriggersAlert","success",r.message||"Triggers reinstalled.");\n' +
  '    })\n' +
  '    .withFailureHandler(function(err){btn.disabled=false;btn.textContent="Reinstall Scheduled Reminders";setInlineAlert("adminRepairTriggersAlert","error","Server error: "+err);})\n' +
  '    .repairScheduledTriggers(appToken);\n' +
  '});\n' +
  'el("adminUsersRefreshBtn").addEventListener("click",fetchAdminUsers);\n' +
  'el("adminVouchersRefreshBtn").addEventListener("click",fetchAdminVouchers);\n' +
  'el("adminCashGivenRefreshBtn").addEventListener("click",fetchAdminCashGivenEntries);\n' +
  'el("adminCashWithdrawalsRefreshBtn").addEventListener("click",fetchAdminCashWithdrawals);\n' +
  'el("cancelCashGivenEditBtn").addEventListener("click",function(){closeModal("adminCashGivenEditModal");});\n' +
  'el("confirmCashGivenEditBtn").addEventListener("click",confirmCashGivenEdit);\n' +
  'el("cancelCashAdvanceEditBtn").addEventListener("click",function(){closeModal("adminCashAdvanceEditModal");});\n' +
  'el("confirmCashAdvanceEditBtn").addEventListener("click",confirmCashAdvanceEdit);\n' +
  'el("adminCashAdvanceLedgerPerson").addEventListener("change",fetchAdminCashAdvanceLedger);\n' +
  'el("rdsCashGivenAddBtn").addEventListener("click",submitRdsCashGiven);\n' +
  'el("rdsCashGivenRefreshBtn").addEventListener("click",fetchRdsCashGivenStatus);\n' +
  'el("cashWithdrawalRequestBtn").addEventListener("click",submitCashWithdrawalRequest);\n' +
  'el("cashWithdrawalRefreshBtn").addEventListener("click",fetchCashWithdrawalStatus);\n' +
  'el("l2WithdrawalRefreshBtn").addEventListener("click",fetchL2WithdrawalRequests);\n' +
  'el("rdsCashGivenAmount").addEventListener("input",function(){\n' +
  '  el("rdsCashGivenAddBtn").disabled=!(Object.keys(_rdsCashGivenSelected).length>0&&parseFloat(this.value)>0);\n' +
  '});\n' +
  'el("cashAdvancesRefreshBtn").addEventListener("click",fetchCashAdvancesBalances);\n' +
  'el("cashAdvancesBalancesPeriod").addEventListener("change",function(){applyBalancesFilterAndRender("cashAdvancesBalancesBody","cashAdvancesBalancesEmpty","cashAdvancesBalancesTable","cashAdvancesLedgerPerson",false);});\n' +
  'el("cashAdvancesBalancesFlaggedOnly").addEventListener("change",function(){applyBalancesFilterAndRender("cashAdvancesBalancesBody","cashAdvancesBalancesEmpty","cashAdvancesBalancesTable","cashAdvancesLedgerPerson",false);});\n' +
  'el("cashAdvancesLedgerPerson").addEventListener("change",fetchCashAdvanceLedger);\n' +
  'el("cashAdvancesLedgerDateFrom").addEventListener("change",function(){applyLedgerDateFilter("cashAdvancesLedgerTable","cashAdvancesLedgerDateFrom","cashAdvancesLedgerDateTo");});\n' +
  'el("cashAdvancesLedgerDateTo").addEventListener("change",function(){applyLedgerDateFilter("cashAdvancesLedgerTable","cashAdvancesLedgerDateFrom","cashAdvancesLedgerDateTo");});\n' +
  'el("cashAdvanceAddBtn").addEventListener("click",submitCashAdvance);\n' +
  'el("subDashAdvancesRefreshBtn").addEventListener("click",function(){\n' +
  '  fetchCashAdvancesBalancesInto("subDashAdvancesBalancesBody","subDashAdvancesBalancesEmpty","subDashAdvancesBalancesTable","subDashAdvancesLedgerPerson",true);\n' +
  '});\n' +
  'el("subDashAdvancesBalancesPeriod").addEventListener("change",function(){applyBalancesFilterAndRender("subDashAdvancesBalancesBody","subDashAdvancesBalancesEmpty","subDashAdvancesBalancesTable","subDashAdvancesLedgerPerson",true);});\n' +
  'el("subDashAdvancesBalancesFlaggedOnly").addEventListener("change",function(){applyBalancesFilterAndRender("subDashAdvancesBalancesBody","subDashAdvancesBalancesEmpty","subDashAdvancesBalancesTable","subDashAdvancesLedgerPerson",true);});\n' +
  'el("subDashAdvancesLedgerPerson").addEventListener("change",function(){\n' +
  '  fetchCashAdvanceLedgerInto("subDashAdvancesLedgerPerson","subDashAdvancesLedgerTable","subDashAdvancesLedgerBody","subDashAdvancesLedgerEmpty","subCashAdvancesAlert");\n' +
  '});\n' +
  'el("subDashAdvancesLedgerDateFrom").addEventListener("change",function(){applyLedgerDateFilter("subDashAdvancesLedgerTable","subDashAdvancesLedgerDateFrom","subDashAdvancesLedgerDateTo");});\n' +
  'el("subDashAdvancesLedgerDateTo").addEventListener("change",function(){applyLedgerDateFilter("subDashAdvancesLedgerTable","subDashAdvancesLedgerDateFrom","subDashAdvancesLedgerDateTo");});\n' +
  'el("apprApplyFilters").addEventListener("click",function(){currentApprFilters=getFilterCriteria("appr");renderVouchers();});\n' +
  'el("apprClearFilters").addEventListener("click",function(){clearFilterInputs("appr");currentApprFilters={};renderVouchers();});\n' +
  'el("adminApplyFilters").addEventListener("click",function(){currentAdminFilters=getFilterCriteria("admin");renderAdminVouchers();});\n' +
  'el("adminClearFilters").addEventListener("click",function(){clearFilterInputs("admin");currentAdminFilters={};renderAdminVouchers();});\n' +
  'el("tallyApplyFilters").addEventListener("click",function(){currentTallyFilters=getFilterCriteria("tally");renderTallyVouchers();});\n' +
  'el("tallyClearFilters").addEventListener("click",function(){clearFilterInputs("tally");currentTallyFilters={};renderTallyVouchers();});\n' +
  'el("auditorRefreshBtn").addEventListener("click",fetchAuditorVouchers);\n' +
  'el("auditorApplyFilters").addEventListener("click",function(){currentAuditorFilters=getFilterCriteria("auditor");renderAuditorVouchers();});\n' +
  'el("auditorClearFilters").addEventListener("click",function(){clearFilterInputs("auditor");currentAuditorFilters={};renderAuditorVouchers();});\n' +
  'el("auditorSearch").addEventListener("input",function(){liveSearch("auditor",function(){currentAuditorFilters.search=el("auditorSearch").value.trim().toLowerCase();renderAuditorVouchers();});});\n' +
  'el("auditorSortBy").addEventListener("change",renderAuditorVouchers);\n' +
  'document.querySelectorAll("#auditorTabBtns .admin-nav-tab").forEach(function(btn){\n' +
  '  btn.addEventListener("click",function(){switchAuditorTab(btn.getAttribute("data-auditor-tab"));});\n' +
  '});\n' +
  'el("auditLogApplyBtn").addEventListener("click",fetchAuditLog);\n' +
  'el("auditLogClearBtn").addEventListener("click",function(){el("auditLogVoucherId").value="";el("auditLogAction").value="";el("auditLogActor").value="";fetchAuditLog();});\n' +
  'el("closeAuditorHistoryBtn").addEventListener("click",function(){closeModal("auditorHistoryModal");});\n' +
  'el("myvApplyFilters").addEventListener("click",function(){currentMyVouchersFilters=getFilterCriteria("myv");renderMyVouchers();});\n' +
  'el("myvClearFilters").addEventListener("click",function(){clearFilterInputs("myv");currentMyVouchersFilters={};renderMyVouchers();});\n' +

  // Live search-as-you-type — the free-text Search field filters
  // immediately (debounced) instead of requiring "Apply Filters", matching
  // how a normal search box behaves. Already matches employee name today
  // (v.submittedBy is part of voucherMatchesFilters\' haystack, and "IOU -
  // Name" matches a plain name search as a substring) — this makes that
  // discoverable/instant rather than requiring an explicit Apply click.
  // The other filter fields (date range, batch, voucher range) keep the
  // existing Apply/Clear button flow.
  'var _searchDebounceTimers={};\n' +
  'function liveSearch(prefix,onSearch){\n' +
  '  clearTimeout(_searchDebounceTimers[prefix]);\n' +
  '  _searchDebounceTimers[prefix]=setTimeout(onSearch,250);\n' +
  '}\n' +
  'el("apprSearch").addEventListener("input",function(){liveSearch("appr",function(){currentApprFilters.search=el("apprSearch").value.trim().toLowerCase();renderVouchers();});});\n' +
  'el("adminSearch").addEventListener("input",function(){liveSearch("admin",function(){currentAdminFilters.search=el("adminSearch").value.trim().toLowerCase();renderAdminVouchers();});});\n' +
  'el("tallySearch").addEventListener("input",function(){liveSearch("tally",function(){currentTallyFilters.search=el("tallySearch").value.trim().toLowerCase();renderTallyVouchers();});});\n' +
  'el("myvSearch").addEventListener("input",function(){liveSearch("myv",function(){currentMyVouchersFilters.search=el("myvSearch").value.trim().toLowerCase();renderMyVouchers();});});\n' +

  // Sort dropdowns — fire immediately on change (display-order preference,
  // not a filter criterion, so no Apply click needed).
  'el("apprSortBy").addEventListener("change",renderVouchers);\n' +
  'el("adminSortBy").addEventListener("change",renderAdminVouchers);\n' +
  'el("tallySortBy").addEventListener("change",renderTallyVouchers);\n' +
  'el("myvSortBy").addEventListener("change",renderMyVouchers);\n' +

  'el("myvOwnerBtns").querySelectorAll("[data-myv-owner]").forEach(function(b){\n' +
  '  b.addEventListener("click",function(){\n' +
  '    el("myvOwnerBtns").querySelectorAll("[data-myv-owner]").forEach(function(x){x.classList.remove("active");});\n' +
  '    b.classList.add("active");\n' +
  '    currentMyVouchersOwner=b.getAttribute("data-myv-owner");\n' +
  '    renderMyVouchers();\n' +
  '  });\n' +
  '});\n' +
  'el("myVouchersRefreshBtn").addEventListener("click",fetchMyVouchers);\n' +
'el("subDashRefreshBtn").addEventListener("click",loadSubmissionDashboard);\n' +
'el("subDashAttentionGoBtn").addEventListener("click",loadMyVouchers);\n' +
'el("subDashAdvGoBtn").addEventListener("click",loadSubCashAdvancesPage);\n' +
'el("subRecentRefreshBtn").addEventListener("click",loadSubRecentPage);\n' +
  // Login page wiring (initLoginUi in the login block above)
  'initLoginUi();\n' +
  'el("cancelEditBtn").addEventListener("click",cancelEdit);\n' +
  'el("cancelRqBtn").addEventListener("click",function(){closeModal("respondQueryModal");});\n' +
  'el("confirmRqBtn").addEventListener("click",submitQueryResponse);\n' +
  'el("rqFiles").addEventListener("change",function(){\n' +
  '  var files=Array.from(el("rqFiles").files);\n' +
  '  rqSelectedFiles=files;\n' +
  '  var c=el("rqFileList");c.innerHTML="";\n' +
  '  files.forEach(function(f){var chip=document.createElement("span");chip.className="file-chip";chip.innerHTML="&#x1F4C4; "+esc(f.name);c.appendChild(chip);});\n' +
  '});\n' +
  'el("tallyRefreshBtn").addEventListener("click",fetchTallyVouchers);\n' +
  'document.querySelectorAll("#tallyModeBtns .filter-btn").forEach(function(btn){\n' +
  '  btn.addEventListener("click",function(){switchTallyMode(btn.getAttribute("data-tally-mode"));});\n' +
  '});\n' +
  'el("tallyGenerateBtn").addEventListener("click",runTallyExport);\n' +
  'el("tallySelectAll").addEventListener("change",function(){\n' +
  '  var checked=this.checked;\n' +
  '  el("tallyVouchersBody").querySelectorAll(".tally-select").forEach(function(cb){cb.checked=checked;});\n' +
  '  updateTallyGenerateState();\n' +
  '});\n' +
  'el("cancelRevertBtn").addEventListener("click",function(){closeModal("revertModal");});\n' +
  'el("confirmRevertBtn").addEventListener("click",confirmRevert);\n' +
  'el("cancelChangeIdBtn").addEventListener("click",function(){closeModal("changeIdModal");});\n' +
  'el("confirmChangeIdBtn").addEventListener("click",confirmChangeId);\n' +
  'el("cancelDeleteVoucherBtn").addEventListener("click",function(){closeModal("deleteVoucherModal");});\n' +
  'el("confirmDeleteVoucherBtn").addEventListener("click",confirmDeleteVoucher);\n' +
  'el("dashBatchSelect").addEventListener("change",function(){renderDashPie(this.value);});\n' +
  'el("cancelChangePwBtn").addEventListener("click",function(){closeModal("changePwModal");});\n' +
  'el("confirmChangePwBtn").addEventListener("click",confirmChangePw);\n' +
  'el("typeRegular").addEventListener("click",function(){setExpenseType("regular");});\n' +
  'el("typeTransport").addEventListener("click",function(){setExpenseType("transport");});\n' +
  'el("ledger").addEventListener("change",updateVehicleRequirement);\n' +
  'el("ledger").addEventListener("change",lsMarkSelected);\n' +
  'el("regularDescription").addEventListener("input",lsOnDescInput);\n' +
  'el("addVendorBtn").addEventListener("click",addVendorRow);\n' +
  'el("requestNewVendorBtn").addEventListener("click",openRequestVendorModal);\n' +
  'el("cancelRequestVendorBtn").addEventListener("click",function(){closeModal("requestNewVendorModal");});\n' +
  'el("confirmRequestVendorBtn").addEventListener("click",confirmRequestVendor);\n' +
  'el("requestNewEmployeeBtn").addEventListener("click",openRequestEmployeeModal);\n' +
  'el("cancelRequestEmployeeBtn").addEventListener("click",function(){closeModal("requestNewEmployeeModal");});\n' +
  'el("confirmRequestEmployeeBtn").addEventListener("click",confirmRequestEmployee);\n' +
  'el("regularAmount").addEventListener("input",updateTotal);\n' +
  'el("uploadZone").addEventListener("click",function(){el("billFiles").click();});\n' +
  'el("billFiles").addEventListener("change",function(){\n' +
  '  var files=Array.from(el("billFiles").files);\n' +
  '  var remainingExistingCount=editVoucherId?existingBillFiles.filter(function(u){return removedBillFileUrls.indexOf(u)<0;}).length:0;\n' +
  '  if(remainingExistingCount+files.length>formMaxFiles){showAlert("submissionAlert","error","Maximum "+formMaxFiles+" files allowed"+(remainingExistingCount?" (including "+remainingExistingCount+" already attached)":"")+".");el("billFiles").value="";return;}\n' +
  '  el("fileList").innerHTML=\'<span class="file-list-status">Compressing \'+files.length+\' file(s)...</span>\';\n' +
  '  compressImageFiles(files).then(function(compressed){\n' +
  '    selectedFiles=compressed;\n' +
  '    renderFileChips();\n' +
  '  });\n' +
  '});\n' +
  'el("submitBtn").addEventListener("click",submitVoucher);\n' +
  'el("voucherNo").addEventListener("blur",checkVoucherNoLive);\n' +
  'el("voucherNo").addEventListener("input",function(){this.value=this.value.replace(/[^0-9]/g,"");});\n' +
  'el("submitAnotherBtn").addEventListener("click",resetForm);\n' +
  'el("refreshBtn").addEventListener("click",fetchVouchers);\n' +
  'el("cancelApproveBtn").addEventListener("click",function(){closeModal("approveModal");});\n' +
  'el("confirmApproveBtn").addEventListener("click",submitApproval);\n' +
  'el("cancelRejectBtn").addEventListener("click",function(){closeModal("rejectModal");});\n' +
  'el("confirmRejectBtn").addEventListener("click",submitRejection);\n' +
  'el("cancelQueryBtn").addEventListener("click",function(){closeModal("queryModal");});\n' +
  'el("confirmQueryBtn").addEventListener("click",submitQuery);\n' +
  'el("queryType").addEventListener("change",refreshQueryLinePicker);\n' +
  'el("closeDetailBtn").addEventListener("click",function(){closeModal("detailModal");});\n' +
  'el("floatingAlertCloseBtn").addEventListener("click",function(){if(_floatingAlertTimer)clearTimeout(_floatingAlertTimer);closeModal("floatingAlertOverlay");});\n' +
  'el("cancelGstBtn").addEventListener("click",function(){closeModal("gstModal");});\n' +
  'el("confirmGstBtn").addEventListener("click",saveGst);\n' +
  'el("noGstBulkBtn").addEventListener("click",bulkMarkNoGst);\n' +
  'document.addEventListener("click",function(e){\n' +
  '  var btn=e.target.closest(".pw-eye-toggle");if(!btn)return;\n' +
  '  var input=el(btn.getAttribute("data-pw-target"));if(!input)return;\n' +
  '  var showing=input.type==="text";\n' +
  '  input.type=showing?"password":"text";\n' +
  '  btn.querySelector(\'[data-pw-eye="open"]\').classList.toggle("hidden",!showing);\n' +
  '  btn.querySelector(\'[data-pw-eye="closed"]\').classList.toggle("hidden",showing);\n' +
  '  btn.setAttribute("aria-pressed",showing?"false":"true");\n' +
  '  btn.setAttribute("aria-label",showing?"Show password":"Hide password");\n' +
  '});\n' +

  'document.querySelectorAll("#filterBtns .filter-btn").forEach(function(btn){\n' +
  '  btn.addEventListener("click",function(){\n' +
  '    currentFilter=btn.getAttribute("data-filter");\n' +
  '    document.querySelectorAll("#filterBtns .filter-btn").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-filter")===currentFilter);});\n' +
  '    renderVouchers();\n' +
  '  });\n' +
  '});\n' +

  // Admin Voucher Monitoring status tabs — same All/Pending L1/Pending\n' +
  // Accounts/Pending L2 pattern as the approval dashboard, scoped to its\n' +
  // own container (not the shared .filter-btn class globally) so it can\'t\n' +
  // cross-talk with the approval dashboard\'s status buttons or the admin\n' +
  // tab-switch buttons, which also happen to reuse .filter-btn for styling.\n' +
  'document.querySelectorAll("#adminVoucherStatusBtns .filter-btn").forEach(function(btn){\n' +
  '  btn.addEventListener("click",function(){\n' +
  '    currentAdminStatusFilter=btn.getAttribute("data-admin-status");\n' +
  '    document.querySelectorAll("#adminVoucherStatusBtns .filter-btn").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-admin-status")===currentAdminStatusFilter);});\n' +
  '    renderAdminVouchers();\n' +
  '  });\n' +
  '});\n' +

  // My Vouchers status tabs — same All/Pending L1/Pending Accounts/Pending
  // L2/Approved/Rejected/Query set as the approval dashboard, for visual
  // and behavioral parity ("same style as the other 3 dashboards"). Scoped
  // to its own container for the same cross-talk reason as the two blocks
  // above — it reuses the "data-filter" attribute name safely because the
  // querySelectorAll itself is scoped to #myvFilterBtns, not the class
  // globally.
  'document.querySelectorAll("#myvFilterBtns .filter-btn").forEach(function(btn){\n' +
  '  btn.addEventListener("click",function(){\n' +
  '    currentMyVouchersStatusFilter=btn.getAttribute("data-filter");\n' +
  '    document.querySelectorAll("#myvFilterBtns .filter-btn").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-filter")===currentMyVouchersStatusFilter);});\n' +
  '    renderMyVouchers();\n' +
  '  });\n' +
  '});\n' +


  'el("vouchersBody").addEventListener("click",function(e){\n' +
  '  var btn=e.target.closest("[data-action]");if(!btn)return;\n' +
  '  var action=btn.getAttribute("data-action"),vid=btn.getAttribute("data-vid");\n' +
  '  if(action==="view")viewDetail(vid);\n' +
  '  else if(action==="approve")openApprove(vid);\n' +
  '  else if(action==="reject")openReject(vid);\n' +
  '  else if(action==="query")openQuery(vid);\n' +
  '  else if(action==="gst")openGstModal(vid);\n' +
  '  else if(action==="regularvendor")openRegularVendorModal(vid);\n' +
  '});\n' +

  'el("vendorsList").addEventListener("click",function(e){\n' +
  '  var btn=e.target.closest("[data-remove-vendor]");if(!btn)return;\n' +
  '  var row=el(btn.getAttribute("data-remove-vendor"));if(row)row.remove();updateTotal();\n' +
  '});\n' +

  'el("fileList").addEventListener("click",function(e){\n' +
  '  var btn=e.target.closest("[data-remove-file]");if(!btn)return;\n' +
  '  selectedFiles.splice(parseInt(btn.getAttribute("data-remove-file"),10),1);renderFileChips();\n' +
  '});\n' +

  'restoreSession();\n' +
  'setInterval(function(){if(appRole&&APPROVAL_ROLES.indexOf(appRole)>=0)fetchVouchers();},60000);\n' +
  // Submission gets its own lighter poll — just enough to keep the query
  // notification badge honest without re-fetching/re-rendering the whole
  // table on the interval used for approvers, since submission may be
  // sitting on the voucher SUBMISSION form (not My Vouchers) most of the
  // time, where a full table refresh would be pointless.
  'setInterval(function(){if(appRole==="submission"&&el("myVouchersPage").classList.contains("active"))fetchMyVouchers();},60000);\n' +

  '})();';

  return '<!DOCTYPE html><html lang="en"><head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1.0">' +
    '<title>Rabale Petty Expense System</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link href="https://fonts.googleapis.com/css2?family=Work+Sans:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">' +
    '<style>' + css + '</style>' +
    '</head><body>' +
    body +
    '<script>' + js + '<\/script>' +
    '</body></html>';
}