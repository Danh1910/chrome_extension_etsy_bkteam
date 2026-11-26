// ==================================================================
//  PANEL CHẨN ĐOÁN ĐỒNG BỘ (tab Sync Order)
//  Hiện: số đơn đọc được trên trang, số đơn cần đối chiếu, kết quả gọi
//  endpoint BKTeam (HTTP status, thời gian, loại lỗi + gợi ý nguyên nhân),
//  test kết nối http/https, kết quả sync gần nhất, danh sách đơn đối chiếu.
//
//  Nạp sau sync_order.js (xem manifest). Dùng function declaration để
//  content_script.js / sync_order.js gọi sang được.
// ==================================================================

const BK_DIAG = {
  // waiting | sending | checking | checked | no_orders | check_failed
  // | no_api_key | parse_error | no_data | no_response | context_lost
  stage: "waiting",
  source: null,
  extractedCount: null,
  rawCount: null,
  cancelled: 0,
  completed: 0,
  toCheck: null,
  endpoint: null,
  attempts: [],
  error: null,
  note: null,
  checkingSince: null,
  checkedAt: null,
  doneRunId: null,
  orderIds: [],
  mbInfos: {},
  ping: null,
  pingRunning: false,
  lastSync: null,
};

const BK_SOURCE_LABEL = {
  html: "HTML trang (Etsy.Context)",
  network: "request mạng của Etsy",
};

const BK_STATUS_LABEL = {
  "Not Synced": { text: "Chưa sync", cls: "om-diag-warn" },
  Synced: { text: "Đã sync", cls: "om-diag-ok" },
  Ignored: { text: "Ignored", cls: "om-diag-muted" },
};

let bkWaitTimer = null;
let bkResponseTimer = null;
let bkPingTimer = null;

function bkEsc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function bkTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("vi-VN");
}

function bkRuntimeAlive() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

// Gửi message sang background. Trả false nếu extension context đã chết
// (extension vừa reload/cập nhật mà trang Etsy chưa F5).
function bkSafeSend(payload) {
  if (!bkRuntimeAlive()) return false;
  try {
    const p = chrome.runtime.sendMessage(payload);
    if (p && typeof p.catch === "function") p.catch(() => {});
    return true;
  } catch (e) {
    console.error("[BK] sendMessage lỗi:", e);
    return false;
  }
}

const bkDiagPanelHtml = `
  <div class="om-diag">
    <div class="om-diag-head">
      <span class="om-diag-title">Chẩn đoán đồng bộ</span>
      <div class="om-diag-actions">
        <button type="button" class="om-diag-btn" id="om-diag-recheck" title="Đọc lại đơn trên trang và gọi lại BKTeam để đối chiếu">Kiểm tra lại</button>
        <button type="button" class="om-diag-btn" id="om-diag-ping" title="Gọi thử endpoint BKTeam qua HTTP và HTTPS">Test kết nối</button>
        <button type="button" class="om-diag-btn om-diag-btn-ghost" id="om-diag-copy" title="Copy thông tin chẩn đoán để gửi kỹ thuật">Copy log</button>
      </div>
    </div>
    <div class="om-diag-body"></div>
  </div>
`;

function bkEnsureDiagPanel() {
  const $wrap = $(".sync-order-wrap");
  if (!$wrap.length) return null;
  let $diag = $wrap.find(".om-diag");
  if (!$diag.length) {
    $diag = $(bkDiagPanelHtml);
    const $heading = $wrap.find(".om-heading");
    if ($heading.length) $heading.after($diag);
    else $wrap.prepend($diag);
  }
  return $diag.find(".om-diag-body");
}

function bkRow(label, valueHtml) {
  return `<div class="om-diag-row"><span class="om-diag-label">${label}</span><div class="om-diag-value">${valueHtml}</div></div>`;
}

function bkMetaText(a) {
  return [a.status ? `HTTP ${a.status}` : null, a.durationMs != null ? `${a.durationMs}ms` : null]
    .filter(Boolean)
    .join(" · ");
}

function bkAttemptHtml(a) {
  if (!a) return "";
  const meta = bkMetaText(a);
  let html = `<div class="om-diag-attempt"><div><b>${bkEsc(a.scheme)}</b> ${
    a.ok
      ? '<span class="om-diag-ok">✔ OK</span>'
      : `<span class="om-diag-bad">✖ ${bkEsc(a.title || a.errorMessage)}</span>`
  }${meta ? ` <span class="om-diag-muted">(${bkEsc(meta)})</span>` : ""}</div>`;
  if (!a.ok && a.hint) html += `<div class="om-diag-hint">${bkEsc(a.hint)}</div>`;
  if (a.redirectedTo) html += `<div class="om-diag-hint">Bị chuyển hướng tới: ${bkEsc(a.redirectedTo)}</div>`;
  if (!a.ok && a.url) html += `<div class="om-diag-hint om-diag-muted">Endpoint: ${bkEsc(a.url)}</div>`;
  if (!a.ok && a.rawSnippet)
    html += `<details class="om-diag-raw"><summary>Nội dung phản hồi</summary><code>${bkEsc(a.rawSnippet)}</code></details>`;
  return html + `</div>`;
}

function bkCounts() {
  const c = { notSynced: 0, synced: 0, ignored: 0, missing: 0, other: 0, tracking: 0 };
  for (const id of BK_DIAG.orderIds) {
    const info = BK_DIAG.mbInfos?.[id];
    if (!info) {
      c.missing++;
      continue;
    }
    if (info.status === "Not Synced") c.notSynced++;
    else if (info.status === "Synced") c.synced++;
    else if (info.status === "Ignored") c.ignored++;
    else c.other++;
    if (info.trackingCode) c.tracking++;
  }
  return c;
}

function bkBkteamStatusHtml() {
  const d = BK_DIAG;
  switch (d.stage) {
    case "waiting":
      return `<span class="om-diag-muted">Chưa gọi (đang chờ dữ liệu đơn)</span>`;
    case "sending":
      return `<span class="om-diag-spin"></span><span class="om-diag-muted">Đang gửi dữ liệu đơn sang background…</span>`;
    case "checking":
      return `<span class="om-diag-spin"></span>Đang gọi BKTeam đối chiếu <b>${d.toCheck ?? "?"}</b> đơn… <span class="om-diag-muted">(bắt đầu ${bkTime(d.checkingSince)})</span>`;
    case "no_orders":
      return `<span class="om-diag-muted">Không có đơn cần đối chiếu nên chưa gọi BKTeam. Bấm "Test kết nối" để kiểm tra mạng.</span>`;
    case "checked": {
      const last = d.attempts[d.attempts.length - 1];
      const c = bkCounts();
      const meta = last ? [last.scheme, bkMetaText(last)].filter(Boolean).join(" · ") : "";
      let html = `<span class="om-diag-ok">✔ Gọi được BKTeam</span> <span class="om-diag-muted">${bkEsc(meta)} · ${bkTime(d.checkedAt)}</span>`;
      if (d.attempts.length > 1) {
        const first = d.attempts[0];
        html += `<div class="om-diag-hint om-diag-warn">${bkEsc(first.scheme)} lỗi (${bkEsc(first.title || first.errorMessage)}) → đã tự chuyển sang ${bkEsc(last.scheme)}.</div>`;
      }
      html += `<div class="om-diag-counts">Chưa sync <b class="om-diag-warn">${c.notSynced}</b> · Đã sync <b class="om-diag-ok">${c.synced}</b> · Ignored <b>${c.ignored}</b>${
        c.other ? ` · Khác <b>${c.other}</b>` : ""
      }${c.missing ? ` · <span class="om-diag-bad">Không có dữ liệu <b>${c.missing}</b></span>` : ""} · Có tracking <b>${c.tracking}</b></div>`;
      return html;
    }
    case "check_failed": {
      let html = `<span class="om-diag-bad">✖ Không gọi được BKTeam để kiểm tra trạng thái</span> <span class="om-diag-muted">${bkTime(d.checkedAt)}</span>`;
      html += (d.attempts || []).map(bkAttemptHtml).join("");
      if (!d.attempts?.length && d.error) html += `<div class="om-diag-hint">${bkEsc(d.error)}</div>`;
      return html;
    }
    default:
      return `<span class="om-diag-bad">✖ ${bkEsc(d.error || d.stage)}</span>`;
  }
}

function bkPingHtml() {
  const d = BK_DIAG;
  if (d.pingRunning) return `<span class="om-diag-spin"></span>Đang gọi thử BKTeam qua HTTP và HTTPS…`;
  const p = d.ping;
  if (!p) return "";
  const results = p.results || [];
  const okSchemes = results.filter((r) => r.ok).map((r) => r.scheme);
  let summary;
  if (results.length && okSchemes.length === results.length)
    summary = `<span class="om-diag-ok">Kết nối tới BKTeam bình thường.</span>`;
  else if (okSchemes.length)
    summary = `<span class="om-diag-warn">Chỉ ${bkEsc(okSchemes.join(", "))} đi được — mạng/proxy đang chặn scheme còn lại. Extension sẽ dùng ${bkEsc(okSchemes[0])}.</span>`;
  else
    summary = `<span class="om-diag-bad">Không tới được BKTeam bằng cả HTTP lẫn HTTPS → lỗi mạng/proxy/VPN hoặc server đang down.</span>`;
  let html = `${summary} <span class="om-diag-muted">${bkTime(p.at)}</span>`;
  if (p.hasApiKey === false) html += `<div class="om-diag-hint om-diag-warn">Chưa có MB API key.</div>`;
  html += results.map(bkAttemptHtml).join("");
  return html;
}

function bkLastSyncHtml() {
  const s = BK_DIAG.lastSync;
  if (!s) return "";
  const meta = [s.status ? `HTTP ${s.status}` : null, s.durationMs != null ? `${s.durationMs}ms` : null, bkTime(s.at)]
    .filter(Boolean)
    .join(" · ");
  if (s.error)
    return `<span class="om-diag-bad">✖ Sync ${s.count} đơn thất bại</span> <span class="om-diag-muted">${bkEsc(meta)}</span><div class="om-diag-hint">${bkEsc(s.error)}</div>`;
  if (s.failed.length)
    return `<span class="om-diag-warn">⚠ ${s.count - s.failed.length}/${s.count} đơn thành công</span> <span class="om-diag-muted">${bkEsc(meta)}</span><div class="om-diag-hint">${s.failed
      .map((f) => `${bkEsc(f.id)}: ${bkEsc(f.msg)}`)
      .join("<br>")}</div>`;
  return `<span class="om-diag-ok">✔ Sync ${s.count} đơn thành công</span> <span class="om-diag-muted">${bkEsc(meta)}</span>`;
}

function bkOrderListHtml(isOpen) {
  const ids = BK_DIAG.orderIds;
  if (!ids.length) return "";
  const rows = ids
    .map((id) => {
      const info = BK_DIAG.mbInfos?.[id];
      let label;
      if (BK_DIAG.stage === "check_failed") label = { text: "Lỗi kiểm tra", cls: "om-diag-bad" };
      else if (!info) label = { text: "Không có dữ liệu", cls: "om-diag-bad" };
      else label = BK_STATUS_LABEL[info.status] || { text: info.status, cls: "" };
      const tracking = info?.trackingCode ? ` <span class="om-diag-muted">· ${bkEsc(info.trackingCode)}</span>` : "";
      return `<div class="om-diag-list-row"><span>${bkEsc(id)}</span><span class="${label.cls}">${bkEsc(label.text)}${tracking}</span></div>`;
    })
    .join("");
  return `<details class="om-diag-list"${isOpen ? " open" : ""}><summary>Danh sách đơn đối chiếu (${ids.length})</summary><div class="om-diag-list-body">${rows}</div></details>`;
}

function bkRenderDiag() {
  const $body = bkEnsureDiagPanel();
  if (!$body) return;
  const d = BK_DIAG;
  const listOpen = $body.find("details.om-diag-list").prop("open");

  const rows = [];
  const count = d.rawCount ?? d.extractedCount;
  let found;
  if (count == null)
    found =
      d.stage === "no_data"
        ? `<span class="om-diag-bad">Chưa đọc được đơn từ trang Etsy</span>`
        : `<span class="om-diag-spin"></span><span class="om-diag-muted">Đang chờ dữ liệu đơn từ Etsy…</span>`;
  else
    found = `<b>${count}</b> đơn <span class="om-diag-muted">(nguồn: ${bkEsc(BK_SOURCE_LABEL[d.source] || d.source || "—")})</span>`;
  rows.push(bkRow("Đơn trên trang", found));

  if (d.toCheck != null) {
    const skipped = [];
    if (d.cancelled) skipped.push(`${d.cancelled} đã hủy`);
    if (d.completed) skipped.push(`${d.completed} đã hoàn tất`);
    rows.push(
      bkRow(
        "Cần đối chiếu",
        `<b>${d.toCheck}</b> đơn${skipped.length ? ` <span class="om-diag-muted">(bỏ qua ${skipped.join(", ")})</span>` : ""}`,
      ),
    );
  }

  rows.push(bkRow("BKTeam", bkBkteamStatusHtml()));
  if (d.pingRunning || d.ping) rows.push(bkRow("Test kết nối", bkPingHtml()));
  if (d.lastSync) rows.push(bkRow("Sync gần nhất", bkLastSyncHtml()));

  let html = rows.join("");
  if (d.note) html += `<div class="om-diag-note">${bkEsc(d.note)}</div>`;
  html += bkOrderListHtml(listOpen);
  $body.html(html);

  const busy = d.stage === "sending" || d.stage === "checking";
  $("#om-diag-recheck").prop("disabled", busy).toggleClass("loader", busy);
  $("#om-diag-ping").prop("disabled", d.pingRunning).toggleClass("loader", d.pingRunning);
  if (typeof setDivHeight === "function") setDivHeight();
}

function bkDiagNote(text) {
  BK_DIAG.note = text;
  bkRenderDiag();
}

// Thay spinner trong tab "Not Synced" bằng thông báo lỗi.
function bkShowSyncNotice(title, detail) {
  $("#not_synced .loader-resp, #ignored .loader-resp, #add_tracking .loader-resp").remove();
  $("#not_synced .om-sync-notice").remove();
  $("#not_synced").prepend(`
    <div class="om-sync-notice">
      <div class="om-sync-notice-title">${bkEsc(title)}</div>
      <div>${bkEsc(detail)}</div>
      <div class="om-sync-notice-hint">Xem chi tiết ở khung "Chẩn đoán đồng bộ" phía trên, xử lý xong bấm "Kiểm tra lại".</div>
    </div>
  `);
}

function bkDiagFail(stage, message) {
  clearTimeout(bkResponseTimer);
  Object.assign(BK_DIAG, { stage, error: message, checkedAt: new Date().toISOString() });
  bkRenderDiag();
  bkShowSyncNotice("Không đồng bộ được", message);
}

function bkDiagInit() {
  if (!$(".sync-order-wrap").length) return;
  if ($(".sync-order-wrap .om-diag").length) return;
  bkRenderDiag();
  // Không có dữ liệu sau 25s (5s delay + thời gian tải) → nói rõ thay vì để spinner quay mãi.
  clearTimeout(bkWaitTimer);
  bkWaitTimer = setTimeout(() => {
    if (BK_DIAG.stage !== "waiting") return;
    BK_DIAG.stage = "no_data";
    BK_DIAG.error = "Chưa đọc được đơn từ trang Etsy";
    bkRenderDiag();
    bkShowSyncNotice(
      "Chưa đọc được danh sách đơn trên trang",
      'Không tìm thấy dữ liệu đơn trong HTML lẫn request mạng của Etsy. Tải lại trang (F5) hoặc bấm "Kiểm tra lại".',
    );
  }, 25000);
}

// Gọi từ mainProcess (nguồn html) và content_script.js (nguồn network).
function bkSendOrderInfo(data, source) {
  window.__BK_LAST_RAW = { data, source };
  clearTimeout(bkWaitTimer);
  Object.assign(BK_DIAG, {
    stage: "sending",
    source,
    extractedCount: Array.isArray(data?.orders) ? data.orders.length : 0,
    rawCount: null,
    toCheck: null,
    attempts: [],
    error: null,
    note: null,
  });
  bkRenderDiag();

  if (!bkSafeSend({ message: "orderInfo", data, source })) {
    bkDiagFail("context_lost", "Extension vừa được cập nhật/tải lại — tải lại trang Etsy (F5) để tiếp tục.");
    return;
  }

  // Background timeout 30s mỗi lần gọi (+ thử scheme thứ 2) → quá 100s chưa có kết quả
  // nghĩa là service worker chết giữa chừng hoặc message bị lạc.
  clearTimeout(bkResponseTimer);
  bkResponseTimer = setTimeout(() => {
    if (BK_DIAG.stage !== "sending" && BK_DIAG.stage !== "checking") return;
    bkDiagFail(
      "no_response",
      "Không nhận được phản hồi từ background sau 100s. Tải lại trang; nếu lặp lại, mở chrome://extensions → Bkteam Etsy Helper → Service worker để xem log.",
    );
  }, 100000);
}

function bkDiagOnProgress(p) {
  if (!p || (p.runId && p.runId === BK_DIAG.doneRunId)) return; // đã có kết quả cuối
  Object.assign(BK_DIAG, {
    stage: p.stage || "checking",
    source: p.source || BK_DIAG.source,
    rawCount: p.rawCount ?? BK_DIAG.rawCount,
    cancelled: p.cancelled || 0,
    completed: p.completed || 0,
    toCheck: p.toCheck ?? null,
    endpoint: p.endpoint || BK_DIAG.endpoint,
    checkingSince: new Date().toISOString(),
    orderIds: [],
    mbInfos: {},
  });
  bkRenderDiag();
}

function bkDiagOnOrdersResult(data) {
  clearTimeout(bkResponseTimer);
  clearTimeout(bkWaitTimer);
  const diag = data?.diag || {};
  const orders = Array.isArray(data?.orders) ? data.orders : [];
  Object.assign(BK_DIAG, {
    stage: diag.stage || (data?.error ? "check_failed" : "checked"),
    doneRunId: diag.runId || null,
    source: diag.source || BK_DIAG.source,
    rawCount: diag.rawCount ?? BK_DIAG.rawCount,
    cancelled: diag.cancelled || 0,
    completed: diag.completed || 0,
    toCheck: diag.toCheck ?? orders.length,
    endpoint: diag.endpoint || BK_DIAG.endpoint,
    attempts: diag.attempts || [],
    error: data?.error || null,
    checkedAt: new Date().toISOString(),
    orderIds: orders.map((o) => o?.orderId).filter(Boolean),
    mbInfos: data?.mbInfos && typeof data.mbInfos === "object" ? data.mbInfos : {},
  });
  bkRenderDiag();
}

function bkDiagOnPing(data) {
  clearTimeout(bkPingTimer);
  BK_DIAG.pingRunning = false;
  BK_DIAG.ping = { ...(data || {}), at: new Date().toISOString() };
  bkRenderDiag();
}

function bkDiagOnSyncResult(data) {
  const orders = Array.isArray(data?.orders) ? data.orders : [];
  const perOrder = data?.data?.error;
  const failed = [];
  if (perOrder && typeof perOrder === "object") {
    for (const o of orders)
      if (perOrder[o.orderId]) failed.push({ id: o.orderId, msg: String(perOrder[o.orderId]) });
  }
  let error = data?.error || null;
  if (error && typeof error !== "string") error = JSON.stringify(error);
  BK_DIAG.lastSync = {
    at: new Date().toISOString(),
    count: orders.length,
    error,
    failed,
    status: data?.request?.status ?? null,
    durationMs: data?.request?.durationMs ?? null,
  };
  // Đơn sync thành công → cập nhật trạng thái trong danh sách đối chiếu.
  if (!error) {
    for (const o of orders) {
      if (failed.some((f) => f.id === o.orderId)) continue;
      if (BK_DIAG.mbInfos?.[o.orderId])
        BK_DIAG.mbInfos[o.orderId] = { ...BK_DIAG.mbInfos[o.orderId], status: "Synced" };
    }
  }
  bkRenderDiag();
}

// Xoá kết quả cũ trước khi "Kiểm tra lại" để bảng phản ánh trạng thái mới.
function bkResetTables() {
  $("#not_synced .om-table tbody, #ignored .om-table tbody, #add_tracking .om-table tbody").empty();
  $(".om-addon .om-synced-all-wrap, .om-addon .om-not-found-wrap, #not_synced .om-sync-notice").remove();
  $(".btn-sync-order-wrap, .btn-revert-order-wrap, .btn-add-tracking-wrap").css("display", "none");
  $(".force-sync-all-item .om-checkbox, .force-revert-all-item .om-checkbox").prop("checked", false);
  $(".om-order-info").empty(); // nhãn trạng thái gắn trên từng đơn của Etsy
  for (const sel of ["#not_synced", "#ignored", "#add_tracking"]) {
    if (!$(`${sel} .loader-resp`).length)
      $(sel).prepend(`<div style="position:relative;height:100px" class="loader-resp"></div>`);
  }
  if (typeof setTextBtnSync === "function") setTextBtnSync();
  if (typeof setTextBtnRevert === "function") setTextBtnRevert();
}

$(document).on("click", "#om-diag-recheck", function () {
  if ($("#sync-order").hasClass("loader")) {
    notifyError("Đang sync đơn, đợi xong rồi hãy kiểm tra lại.");
    return;
  }
  let raw = window.__BK_LAST_RAW;
  if (!raw && typeof extractDataFromAllScripts === "function") {
    const fromHtml = extractDataFromAllScripts();
    if (fromHtml) raw = { data: fromHtml, source: "html" };
  }
  if (!raw) {
    bkDiagFail(
      "no_data",
      "Không đọc được dữ liệu đơn trên trang (HTML không có Etsy.Context và chưa bắt được request mạng). Tải lại trang (F5).",
    );
    return;
  }
  bkResetTables();
  bkSendOrderInfo(raw.data, raw.source);
});

$(document).on("click", "#om-diag-ping", function () {
  if (BK_DIAG.pingRunning) return;
  if (!bkSafeSend({ message: "bkPing" })) {
    bkDiagFail("context_lost", "Extension vừa được cập nhật/tải lại — tải lại trang Etsy (F5) để tiếp tục.");
    return;
  }
  BK_DIAG.pingRunning = true;
  bkRenderDiag();
  // Mỗi scheme timeout 15s, chạy song song → 40s chưa về là background không trả lời.
  clearTimeout(bkPingTimer);
  bkPingTimer = setTimeout(() => {
    if (!BK_DIAG.pingRunning) return;
    BK_DIAG.pingRunning = false;
    BK_DIAG.ping = {
      at: new Date().toISOString(),
      results: [
        { scheme: "—", ok: false, title: "Background không phản hồi sau 40s", hint: "Tải lại trang rồi thử lại." },
      ],
    };
    bkRenderDiag();
  }, 40000);
});

$(document).on("click", "#om-diag-copy", async function () {
  const d = BK_DIAG;
  const report = {
    at: new Date().toISOString(),
    extensionVersion: bkRuntimeAlive() ? chrome.runtime.getManifest().version : null,
    page: window.location.href,
    userAgent: navigator.userAgent,
    online: navigator.onLine,
    stage: d.stage,
    source: d.source,
    rawCount: d.rawCount ?? d.extractedCount,
    cancelled: d.cancelled,
    completed: d.completed,
    toCheck: d.toCheck,
    error: d.error,
    attempts: d.attempts,
    counts: bkCounts(),
    ping: d.ping,
    lastSync: d.lastSync,
    orders: d.orderIds.map((id) => ({ id, status: d.mbInfos?.[id]?.status || null })),
  };
  const text = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  notifySuccess("Đã copy thông tin chẩn đoán.");
});

// Phòng khi initAddon (content_script.js) chạy trước khi file này được nạp.
if ($(".sync-order-wrap").length) bkDiagInit();
