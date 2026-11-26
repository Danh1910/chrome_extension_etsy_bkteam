// Chạy trong MAIN world của trang Etsy (khai báo trong manifest, run_at document_start).
// Bắt response API danh sách đơn của Etsy (khi tải trang / đổi View / lật trang / lọc)
// rồi postMessage sang content script.
//
// Hook cả fetch lẫn XHR, nhận URL dạng string/Request/URL. Lưu lại request gần nhất
// để nút "Kiểm tra lại" gọi lại đúng danh sách đang xem (BK_REFETCH_ORDERS).
if (window.myEtsyInjectorHasRun) {
  console.log("Injector script đã chạy, không thực thi lại.");
} else {
  window.myEtsyInjectorHasRun = true;

  const ORDERS_URL_RE = /\/mission-control\/orders(?:[/?]|$)/i;
  const originFetch = window.fetch;

  const toUrlString = (input) => {
    try {
      if (!input) return "";
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.href;
      if (typeof Request !== "undefined" && input instanceof Request) return input.url;
      return String(input);
    } catch (e) {
      return "";
    }
  };

  const headersToObject = (h) => {
    const out = {};
    try {
      if (!h) return out;
      new Headers(h).forEach((v, k) => {
        out[k] = v;
      });
    } catch (e) {}
    return out;
  };

  const looksLikeOrders = (data) => !!data && typeof data === "object" && Array.isArray(data.orders);

  const urlMeta = (url) => {
    try {
      const u = new URL(url, location.origin);
      const num = (k) => {
        const v = u.searchParams.get(k);
        return v != null && v !== "" && !isNaN(Number(v)) ? Number(v) : null;
      };
      return { limit: num("limit"), offset: num("offset") };
    } catch (e) {
      return {};
    }
  };

  const publish = (url, data, extra) => {
    if (!looksLikeOrders(data)) return;
    // Request chỉ để đếm số lượng (limit=0) — không phải danh sách đang xem.
    if (urlMeta(url).limit === 0) return;
    console.log("INJECTED.JS: Fetched and posting data:", data);
    window.postMessage({ type: "FROM_MY_EXTENSION", data, meta: { ...urlMeta(url), ...(extra || {}) } });
  };

  const remember = (url, method, headers) => {
    if (String(method || "GET").toUpperCase() !== "GET") return;
    if (urlMeta(url).limit === 0) return;
    window.__bkLastOrdersReq = { url: new URL(url, location.origin).href, headers: headers || {} };
  };

  // ---- fetch ----
  window.fetch = async (...args) => {
    const res = await originFetch(...args);
    try {
      const url = toUrlString(args[0]);
      if (url && ORDERS_URL_RE.test(url)) {
        const req = typeof Request !== "undefined" && args[0] instanceof Request ? args[0] : null;
        const method = args[1]?.method || req?.method || "GET";
        remember(url, method, { ...headersToObject(req?.headers), ...headersToObject(args[1]?.headers) });
        res
          .clone()
          .json()
          .then((data) => publish(url, data))
          .catch((e) => console.log(e?.toString()));
      }
    } catch (e) {
      console.log("INJECTED.JS fetch hook error:", e?.toString());
    }
    return res;
  };

  // ---- XHR ----
  const XHR = XMLHttpRequest.prototype;
  const originOpen = XHR.open;
  const originSetHeader = XHR.setRequestHeader;
  const originSend = XHR.send;

  XHR.open = function (method, url, ...rest) {
    this.__bkUrl = toUrlString(url);
    this.__bkMethod = method;
    this.__bkHeaders = {};
    return originOpen.call(this, method, url, ...rest);
  };
  XHR.setRequestHeader = function (k, v) {
    if (this.__bkHeaders) this.__bkHeaders[k] = v;
    return originSetHeader.call(this, k, v);
  };
  XHR.send = function (...args) {
    const url = this.__bkUrl;
    if (url && ORDERS_URL_RE.test(url)) {
      remember(url, this.__bkMethod, this.__bkHeaders);
      this.addEventListener("load", () => {
        try {
          let data = null;
          if (this.responseType === "json") data = this.response;
          else if (this.responseType === "" || this.responseType === "text") data = JSON.parse(this.responseText);
          publish(url, data);
        } catch (e) {
          console.log("INJECTED.JS XHR parse error:", e?.toString());
        }
      });
    }
    return originSend.apply(this, args);
  };

  // ---- "Kiểm tra lại": gọi lại request danh sách đơn gần nhất ----
  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.data?.type !== "BK_REFETCH_ORDERS") return;
    const last = window.__bkLastOrdersReq;
    if (!last) {
      window.postMessage({ type: "BK_REFETCH_RESULT", ok: false, reason: "no_request" });
      return;
    }
    try {
      const res = await originFetch(last.url, { method: "GET", credentials: "include", headers: last.headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!looksLikeOrders(data)) throw new Error("Phản hồi không có danh sách đơn");
      window.postMessage({ type: "BK_REFETCH_RESULT", ok: true, count: data.orders.length });
      publish(last.url, data, { refetch: true });
    } catch (err) {
      window.postMessage({ type: "BK_REFETCH_RESULT", ok: false, reason: err?.message || String(err) });
    }
  });
}
