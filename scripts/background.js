const isProduction = true;
const MBUrl = "http://bkteam.top/dungvuong-admin/api/Order_Sync_Etsy_to_System_Api.php";
const EtsyDomain = "https://www.etsy.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stopInteval = (params) => {
  clearInterval(params);
};

let doingAuto = false;

const sendMessage = (tabId, message, data) => {
  let timeOut = 0;
  let start = setInterval(function () {
    chrome.tabs.sendMessage(
      tabId,
      {
        message,
        data,
      },
      function (response) {
        if (!chrome.runtime.lastError && response?.message === "received")
          stopInteval(start);
        if (timeOut == 30) stopInteval(start);
      },
    );
    timeOut++;
  }, 1000);
};

const sendToContentScript = (msg, data) =>
  new Promise(async (resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs.length || !tabs[0].id) return resolve(false);
      sendMessage(tabs[0].id, msg, data);
      resolve(true);
    });
  });

// DÁN HÀM MỚI NÀY VÀO
const getMBApiKey = () => {
  return new Promise((resolve) => {
    // Trực tiếp lấy key từ storage, không cần hỏi ai cả
    chrome.storage.local.get("MBApi", (result) => {
      resolve(result.MBApi);
    });
  });
};

const API_KEY_SPECIAL = ["etsyapi-962d89a0-f2f9-4919-9854-e9be5f3325ca"];

const convertTime = (orderDate) => {
  let dateStr = orderDate + "";
  if (dateStr.length < 13) {
    dateStr += "0".repeat(13 - dateStr.length);
  }
  // return new Date(parseInt(dateStr)).toISOString();
  const date = new Date(parseInt(dateStr));
  const pstDate = date.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
  });

  const formatVal = (val) => {
    val = String(val);
    if (val.length === 1) {
      val = "0" + val;
    }
    return val;
  };

  const [T1, T2] = pstDate.split(/,/).map((i) => i.trim());
  let [mo, d, y] = T1.split(/\//g).map((i) => formatVal(i));
  let [h, m, s] = T2.split(/\:/g).map((i) => formatVal(i));
  [s] = s.split(" ");

  const pt = /PM/gi;
  if (!!pstDate.match(pt)) {
    h = parseInt(h) + 12;
    if (h >= 24) {
      h = h - 24;
      d = parseInt(d) + 1;
   }
  }

  const res = `${[y, mo, d].join("-")}T${[h, m, s].join(":")}.000Z`;
  return res;
}; // etsyapi-45fdd139-9a95-4905-a041-a2a916285bef

const getOrders = (data, mbApiKey, stats = {}) => {
  const orders = [];
  const mapBuyer = {};
  stats.rawCount = Array.isArray(data?.orders) ? data.orders.length : 0;
  stats.cancelled = 0;
  stats.completed = 0;
  if (!data.buyers || !data.orders) return;
  for (const buyer of data.buyers) {
    mapBuyer[buyer.buyer_id] = buyer;
  }

// Function to convert display_name (e.g., "Ship by Sep 9, 2024", "Ship tomorrow", or "Ship today") to ISO 8601 date format
  const convertToPDT = (displayName) => {
    if (displayName.includes("today")) {
      // If it's "Ship today", get the current date
      const today = new Date();

      // Convert to ISO format
      return today.toISOString();
    }

    if (displayName.includes("tomorrow")) {
      // If it's "Ship tomorrow", get the current date and add 1 day
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      // Convert to ISO format
      return tomorrow.toISOString();
    }

    // Convert display_name like "Ship by Sep 9, 2024" to ISO format
    const dateMatch = displayName.match(/Ship by (\w+ \d+, \d+)/);
    if (dateMatch && dateMatch[1]) {
      const dateObj = new Date(dateMatch[1]);

      // Convert to ISO format
      return dateObj.toISOString();
    }

    return 'No ship by date';
  };

  // Map order groups to get "Ship by date" in PDT
  const shipByDates = {};
  if (data?.order_groups?.length > 0) {
    for (let group of data.order_groups) {
      for (let orderId of group.order_ids) {
        shipByDates[orderId] = convertToPDT(group.display_name);
      }
    }
  }

  // Convert Unix timestamp to ISO 8601 format for expected_ship_date
  const convertTimestampToISO = (timestamp) => {
    const dateObj = new Date(timestamp * 1000); // Convert from seconds to milliseconds
    return dateObj.toISOString();
  };

  const convertEstimatedDelivery = (deliveryDateStr) => {

    // Case: "Jan 26-Feb 7" (range khác tháng) -> lấy ngày cuối
    const crossMonthMatch = deliveryDateStr.match(/(\w+)\s(\d+)\s*-\s*(\w+)\s(\d+)/);
    if (crossMonthMatch) {
      const endMonth = crossMonthMatch[3];
      const endDay = crossMonthMatch[4];
      const currentYear = new Date().getFullYear();
      const fullDateStr = `${endMonth} ${endDay}, ${currentYear}`;
      const dateObj = new Date(fullDateStr);
      if (!isNaN(dateObj.getTime())) {
        return dateObj.toISOString();
      }
    }
    // Regex này được thiết kế riêng cho các định dạng như "Jun 23-25" hoặc "Jun 23"
    // Groups: 1=Tháng, 2=Ngày bắt đầu, 3=Ngày kết thúc (nếu có)
    const dateMatch = deliveryDateStr.match(/(\w+)\s(\d+)(?:-(\d+))?/);

    if (dateMatch) {
      const month = dateMatch[1];      // Lấy ra tháng, ví dụ: "Jun"
      const dayEnd = dateMatch[3] || dateMatch[2]; // Lấy ngày kết thúc, nếu không có thì lấy ngày bắt đầu

      // Lấy năm hiện tại
      const currentYear = new Date().getFullYear();

      // Tạo chuỗi ngày tháng đầy đủ để convert
      // Ví dụ: "Jun 25, 2025"
      const fullDateStr = `${month} ${dayEnd}, ${currentYear}`;

      const dateObj = new Date(fullDateStr);

      // Kiểm tra xem date có hợp lệ không trước khi trả về
      if (!isNaN(dateObj.getTime())) {
        // Trả về định dạng ISO 8601 (UTC)
        return dateObj.toISOString();
      }
    }

    // Nếu không match hoặc ngày không hợp lệ, trả về null
    return null;
  };

  // Map transactions
  let transactionsObj = {};
  if (data?.transactions?.length > 0) {
    for (let item of data.transactions) {
      if (!item || typeof item !== "object" || !item.transaction_id) continue;
      transactionsObj[item.transaction_id] = item;
    }
  }

  for (const order of data.orders) {
    if (order.is_canceled) {
      stats.cancelled++;
      continue;
    }

    // case: order's completed (`order.fulfillment.is_complete` = true) => skip
    if (!API_KEY_SPECIAL.includes(mbApiKey)) {
      if (order.fulfillment && order.fulfillment.is_complete) {
        stats.completed++;
        continue;
      }
    }

    const buyer = mapBuyer[order.buyer_id];
    const shipping = order.fulfillment.to_address;
    const payment = order.payment.cost_breakdown;
    const notes = order.notes;
    let note = null;
    if (notes) {
      const { type, note_from_buyer } = notes;
      if (type == "Etsy_Order_Notes" && note_from_buyer)
        note = notes.note_from_buyer;
    }



    // Get estimated delivery date in ISO format (taking last day of the range)
    const estimatedDeliveryDate = order.fulfillment?.status?.physical_status?.estimated_delivery_date
        ? convertEstimatedDelivery(order.fulfillment.status.physical_status.estimated_delivery_date)
        : '';

    // Get ship by date in ISO 8601 format from expected_ship_date
    const shipByDate = order.fulfillment?.status?.physical_status?.shipping_status?.expected_ship_date
        ? convertTimestampToISO(order.fulfillment.status.physical_status.shipping_status.expected_ship_date)
        : 'No ship by date';

    const newOrder = {
      orderId: String(order.order_id),
      orderDate: convertTime(order.order_date || ""),
      shipByDate: shipByDate, // Add ship by date here (now converted to PDT)
      deliveryByDate: estimatedDeliveryDate, // Add delivery date here
      note: note,  // Add note from buyer here
      buyer: {
        email: buyer?.email,
        name: buyer?.name,
      },
      shipping: {
        name: shipping.name,
        address1: shipping.first_line,
        address2: shipping.second_line,
        city: shipping.city,
        state: shipping.state,
        zipCode: shipping.zip,
        country: shipping.country,
        phone: shipping.phone,
      },
      shippingMethod: order.fulfillment.shipping_method,
      grandTotal: payment.total_cost.value / 100,
      subTotal: payment.items_cost.value / 100,
      shippingTotal: payment.shipping_cost.value / 100,
      taxTotal: payment.tax_cost.value / 100,
      discountTotal: payment.discount.value / 100,
      items: [],
    };
    if (!order.transactions || order.transactions.length === 0) {
      if (order.transaction_ids?.length > 0) {
        let newTransactions = [];
        for (const id of order.transaction_ids) {
          if (transactionsObj[id] != null) {
            newTransactions.push(transactionsObj[id]);
          }
        }
        order.transactions = newTransactions;
      }
    }

    for (const transaction of order.transactions) {
      const newItem = {
        itemId: String(transaction.transaction_id),
        qty: transaction.quantity,
        isDigital: transaction.product.is_digital,
        isPersonalized: transaction.is_personalizable,
        productId: String(transaction.listing_id),
        productVariantId: String(transaction.product.product_id),
        sku: transaction.product.product_identifier,
        title: transaction.product.title,
        image: transaction.product.image_url_75x75.replace(
          "il_75x75",
          "il_fullxfull",
        ),
        isDigital: transaction.product.is_digital,
        price: transaction.cost.value / 100,
        shippingCost: 0,
        attributes: [],
        personalized: [],
      };
      if (note) newItem.note = note;
      for (const variation of transaction.variations) {
        if (variation.property === "Personalization") {
          newItem.personalized.push({
            name: variation.property,
            value: variation.value,
          });
        } else {
          newItem.attributes.push({
            name: variation.property,
            value: variation.value,
          });
        }
      }
      newOrder.items.push(newItem);
    }
    orders.push(newOrder);
  }
  return orders;
};

// ==================================================================
//  Gọi API BKTeam — có timeout + chẩn đoán lỗi
// ==================================================================
// Trước đây fetch không có timeout: proxy treo kết nối là panel quay loader mãi,
// còn lỗi thì chỉ còn mỗi chữ "Failed to fetch". requestMB trả kèm `meta` mô tả
// request (URL, HTTP status, thời gian, loại lỗi) để panel hiện cho người dùng.
const MB_URL_ALT = MBUrl.startsWith("http:")
  ? MBUrl.replace(/^http:/, "https:")
  : MBUrl.replace(/^https:/, "http:");
// Scheme gọi được gần nhất. Chỉ đổi khi request đối chiếu/test thành công qua scheme kia.
let preferredMBUrl = MBUrl;

const MB_TIMEOUT_MS = {
  check: 30000,
  ping: 15000,
  create: 120000,
  default: 60000,
};

const textSnippet = (text, max = 300) => {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
};

const requestMB = async ({
  endPoint,
  apiKey,
  body,
  timeoutMs = MB_TIMEOUT_MS.default,
  baseUrl,
}) => {
  if (!apiKey) apiKey = await getMBApiKey();
  const base = baseUrl || preferredMBUrl;
  const url = endPoint ? `${base}?case=${endPoint}` : base;

  const meta = {
    url,
    scheme: url.split(":")[0].toUpperCase(),
    ok: false,
    status: null,
    durationMs: null,
    errorType: null, // network | timeout | http | invalid_json | server
    errorMessage: null,
    rawSnippet: null,
    redirectedTo: null,
    at: new Date().toISOString(),
  };

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        merchantId: apiKey, // Sử dụng merchantId như một apiKey
      },
      body,
      signal: controller.signal,
    });
    meta.status = resp.status;
    if (resp.redirected) meta.redirectedTo = resp.url;
    const text = await resp.text();
    meta.durationMs = Date.now() - startedAt;

    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = null;
    }

    if (!resp.ok) {
      meta.errorType = "http";
      meta.errorMessage = `HTTP ${resp.status}${resp.statusText ? " " + resp.statusText : ""}`;
      meta.rawSnippet = textSnippet(text);
      return { meta, json };
    }
    if (json === null || typeof json !== "object") {
      meta.errorType = "invalid_json";
      meta.errorMessage = "Phản hồi không phải JSON";
      meta.rawSnippet = textSnippet(text);
      return { meta, json: null };
    }
    meta.ok = true;
    return { meta, json };
  } catch (error) {
    meta.durationMs = Date.now() - startedAt;
    if (error?.name === "AbortError") {
      meta.errorType = "timeout";
      meta.errorMessage = `Không phản hồi sau ${Math.round(timeoutMs / 1000)}s`;
    } else {
      meta.errorType = "network";
      meta.errorMessage = error?.message || String(error);
    }
    return { meta, json: null };
  } finally {
    clearTimeout(timer);
  }
};

// Diễn giải lỗi cho người dùng: tiêu đề ngắn + gợi ý nguyên nhân.
const describeMBError = (meta) => {
  if (!meta || meta.ok) return { title: "", hint: "" };
  switch (meta.errorType) {
    case "network":
      return {
        title: `Không kết nối được tới BKTeam (${meta.errorMessage})`,
        hint:
          "Request không tới được server: mạng/proxy/VPN/firewall đang chặn bkteam.top, DNS không phân giải được, " +
          "hoặc server đang down. Thử tắt proxy/VPN, đổi mạng, hoặc mở thử link endpoint trên trình duyệt.",
      };
    case "timeout":
      return {
        title: `BKTeam không phản hồi (${meta.errorMessage})`,
        hint: "Proxy giữ kết nối mà không trả về, mạng quá chậm, hoặc server đang quá tải.",
      };
    case "http": {
      const s = meta.status;
      let hint = "Server nhận được request nhưng trả lỗi.";
      if (s === 407) hint = "Proxy yêu cầu đăng nhập (407) — kiểm tra cấu hình proxy.";
      else if (s === 403) hint = "Bị chặn (403) — có thể firewall/chống DDoS của server chặn IP hoặc proxy này.";
      else if (s === 404) hint = "Không tìm thấy endpoint (404) — đường dẫn API đã đổi hoặc proxy chuyển hướng sai.";
      else if (s >= 500 && s !== 502 && s !== 503 && s !== 504) hint = "Lỗi phía server BKTeam (PHP/DB) — báo kỹ thuật.";
      else if (s === 502 || s === 503 || s === 504)
        hint = "Gateway/proxy không lấy được phản hồi từ server (502/503/504) — server down hoặc proxy lỗi.";
      return { title: `BKTeam trả lỗi ${meta.errorMessage}`, hint };
    }
    case "invalid_json":
      return {
        title: "BKTeam trả về dữ liệu không đọc được (không phải JSON)",
        hint:
          "Thường là trang lỗi/đăng nhập của proxy hoặc nhà mạng chèn vào, hoặc PHP in warning trước JSON. Xem nội dung phản hồi bên dưới.",
      };
    case "server":
      return {
        title: `BKTeam báo lỗi: ${meta.errorMessage}`,
        hint: "Kết nối OK nhưng server xử lý lỗi — báo kỹ thuật kèm nội dung này.",
      };
    default:
      return { title: meta.errorMessage || "Lỗi không xác định", hint: "" };
  }
};

const attachHint = (meta) => {
  const { title, hint } = describeMBError(meta);
  meta.title = title;
  meta.hint = hint;
  return meta;
};

const mbErrorText = (meta) => {
  const { title, hint } = describeMBError(meta);
  return hint ? `${title}. ${hint}` : title;
};

// Wrapper giữ tương thích cho các chỗ gọi cũ: trả về body JSON, lỗi thì { error }.
const sendRequestToMB = async (endPoint, apiKey, data, timeoutMs) => {
  const { meta, json } = await requestMB({ endPoint, apiKey, body: data, timeoutMs });
  if (meta.ok) return json;
  const base = json && typeof json === "object" ? json : {};
  return { ...base, error: mbErrorText(meta), __meta: meta };
};

// Đối chiếu đơn với BKTeam. Lỗi tầng mạng (network/timeout) thì thử thêm scheme kia
// (http <-> https) vì nhiều mạng/proxy chặn riêng http thường.
const checkSyncedOrdersOnMB = async (orderIds, apiKey, timeoutMs = MB_TIMEOUT_MS.check) => {
  const body = JSON.stringify({ originIds: JSON.stringify(orderIds) });
  const bases = [preferredMBUrl, ...[MBUrl, MB_URL_ALT].filter((u) => u !== preferredMBUrl)];
  const attempts = [];

  for (const base of bases) {
    const { meta, json } = await requestMB({
      endPoint: "checkEtsySyncedOrders",
      apiKey,
      body,
      timeoutMs,
      baseUrl: base,
    });
    if (meta.ok) {
      let serverError = null;
      if (json.error) serverError = typeof json.error === "string" ? json.error : JSON.stringify(json.error);
      else if (Array.isArray(json.errors) && json.errors.length) serverError = json.errors[0]?.message || "errors";
      else if (json.data == null || typeof json.data !== "object") serverError = "Phản hồi thiếu trường data";
      if (serverError) {
        meta.ok = false;
        meta.errorType = "server";
        meta.errorMessage = serverError;
      }
    }
    attempts.push(attachHint(meta));

    if (meta.ok) {
      preferredMBUrl = base;
      return { ok: true, data: json.data, attempts };
    }
    // Lỗi HTTP/JSON/server nghĩa là server đã nhận request — đổi scheme không giúp gì.
    if (meta.errorType !== "network" && meta.errorType !== "timeout") break;
  }

  return { ok: false, data: {}, attempts, error: mbErrorText(attempts[attempts.length - 1]) };
};

// capture event from content script
chrome.runtime.onMessage.addListener(async (req, sender, res) => {
  const { message, data } = req || {};
  if (message === "syncOrderToMB") {
    const { apiKey, orders } = data;

    if (!apiKey || !orders || !orders.length) return;
    // Split order
    const newOrders = [];
    for (let order of orders) {
      if (!order || typeof order !== "object") continue;
      const { splitCount, ...rest } = order;
      if (!splitCount || splitCount === 1) {
        newOrders.push(rest);
        continue;
      }

      // push first item;
      const newItems = [];
      for (let item of rest.items) {
        for (let i = 0; i < splitCount; i++) {
          let itemId = item.itemId;
          itemId = i ? `${itemId}-${i}` : itemId;
          newItems.push({ ...item, itemId, qty: 1 });
        }
      }

      newOrders.push({ ...rest, items: newItems });
    }
    let query = JSON.stringify({
      input: newOrders,
      merchantId: apiKey  // Thêm merchantId vào query
    });
    const { meta, json } = await requestMB({
      endPoint: "createEtsyOrder",
      apiKey,
      body: query,
      timeoutMs: MB_TIMEOUT_MS.create,
    });
    const result = json && typeof json === "object" ? json : {};
    // Trước đây lỗi mạng rơi vào result.error (không phải result.errors) nên content
    // coi như thành công và xoá dòng đơn khỏi bảng. Giờ lỗi kết nối luôn đi vào `error`.
    let error = result.errors || null;
    if (!meta.ok) {
      error = mbErrorText(meta);
      if (meta.errorType === "timeout")
        error += " Đơn có thể đã được tạo trên server — bấm \"Kiểm tra lại\" trước khi sync lại.";
    }
    const resp = {
      orders,
      data: result, // Gắn thẳng kết quả server trả về vào 'data'
      error,
      request: attachHint(meta),
    };
    sendMessage(sender.tab.id, "syncOrderToMB", resp);

    if (data?.markSynced) {
      await sendToContentScript("auto_synced");
    }
  }
  if (message === "deleteIgnoreOrder") {
    const { apiKey, orders } = data;
    if (!apiKey || !orders || !orders.length) return;
    let query = JSON.stringify({
      operationName: "deleteIgnoreEtsyOrder",
      variables: {
        originOrderIds: orders.map((o) => o.orderId),
      },
      query:
        "mutation deleteIgnoreEtsyOrder($originOrderIds: [ID!]!) {deleteIgnoreEtsyOrder(originOrderIds: $originOrderIds)}",
    });
    const result = await sendRequestToMB(null, apiKey, query);
    const resp = {
      orders,
      data: result.data ? result.data.deleteIgnoreEtsyOrder : null,
      error: result.errors
        ? result.errors[0].message
        : result.error
          ? String(result.error)
          : !result.data
            ? "BKTeam không trả dữ liệu"
            : null,
    };
    sendMessage(sender.tab.id, "deleteIgnoreEtsyOrder", resp);
  }

  // Nút "Test kết nối BKTeam" trên panel: gọi checkEtsySyncedOrders với danh sách rỗng
  // (chỉ đọc, server trả { data: [] }) qua cả http và https để biết scheme nào đi được.
  if (message === "bkPing") {
    const tabId = sender?.tab?.id;
    const apiKey = await getMBApiKey();
    const body = JSON.stringify({ originIds: "[]" });
    const results = await Promise.all(
      [MBUrl, MB_URL_ALT].map(async (base) => {
        const { meta, json } = await requestMB({
          endPoint: "checkEtsySyncedOrders",
          apiKey,
          body,
          timeoutMs: MB_TIMEOUT_MS.ping,
          baseUrl: base,
        });
        if (meta.ok && json?.error) {
          meta.ok = false;
          meta.errorType = "server";
          meta.errorMessage = String(json.error);
        }
        return { base, meta: attachHint(meta) };
      }),
    );
    const firstOk = results.find((r) => r.meta.ok);
    if (firstOk && !results.find((r) => r.base === preferredMBUrl)?.meta.ok) {
      preferredMBUrl = firstOk.base;
    }
    if (tabId != null)
      sendMessage(tabId, "bkPingResult", {
        hasApiKey: !!apiKey,
        preferredUrl: preferredMBUrl,
        results: results.map((r) => r.meta),
      });
  }
  if (message === "fetchTrackChinaToUS") {
    const { endpoint } = data;
    chrome.tabs.create({ url: endpoint }, (tab) => {
      sendMessage(tab.id, "fetchTrackChinaToUS", {
        receiverId: sender.tab.id,
      });
    });
  }
  if (message === "fetchedTrackChinaToUS") {
    const { receiverId, validTracks } = data;
    chrome.tabs.remove(sender.tab.id);
    chrome.tabs.update(receiverId, { selected: true });
    sendMessage(receiverId, "fetchedTrackChinaToUS", {
      validTracks,
    });
  }
  if (message === "addedTrackingCode") {
    const { orderId: infoOrderId, tracking: infoTracking } = data;

    // Gửi thông tin order và tracking lên server
    const infoQuery = JSON.stringify({
      orderId: infoOrderId,
      trackingCode: infoTracking,
    });

    const resInfoTrack = await sendRequestToMB("addedTrackingCode", null, infoQuery);
    // Không điều hướng sau khi gửi thông tin, chỉ thực hiện phần gửi thông tin này
  }

  // Auto sync order
  if (message === "autoReady") {
    if (doingAuto) return;

    doingAuto = true;
    openOrderPage();
    return;
  }
  return;
});

// capture event from popup
chrome.runtime.onMessage.addListener(async (req, sender, res) => {
  const { message, data } = req || {};
  switch (message) {
    case "popupSaveApiKey":
      sendToContentScript("popupSaveApiKey", data);
      break;
    case "popupGetApiKey":
      sendToContentScript("popupGetApiKey", null);
    default:
      break;
  }
});

// capture event from devtool
chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== "captureOrders") return;
  port.onMessage.addListener(async (msg) => {
    const { message, data } = msg || {};
    return;
    // get data from `injected` script
    switch (message) {
      case "orderInfo":
        const mbApiKey = await getMBApiKey();
        if (!mbApiKey) return;
        if (!data) break;
        const orders = getOrders(data, mbApiKey);
        console.log("orders:", orders);
        const resp = {
          orders,
          mbInfos: {},
          error: null,
        };

        if (orders.length === 0) {
          sendToContentScript("orders", resp);
          return;
        }
        // check synced orders
        const query = JSON.stringify({
          originIds: JSON.stringify(orders.map((o) => o["orderId"]))
        });
        const result = await sendRequestToMB("checkEtsySyncedOrders", mbApiKey, query);
        resp.mbInfos = result.data;
        resp.error = result.error
            ? result.error
            : result.errors
                ? result.errors[0].message
                : null;

        sendToContentScript("orders", resp);
        break;
      default:
        break;
    }
  });
});

// message from `content_script`
chrome.runtime.onMessage.addListener(async (req, sender) => {
  const { message, data, source } = req || {};
  switch (message) {
    case "orderInfo": {
      // Trả về đúng tab đã gửi. Trước đây gửi cho "tab đang active" — người dùng
      // chuyển sang tab khác lúc đang đối chiếu là panel không bao giờ nhận được kết quả.
      const tabId = sender?.tab?.id;
      const reply = (msg, payload) =>
        tabId != null ? sendMessage(tabId, msg, payload) : sendToContentScript(msg, payload);
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      const mbApiKey = await getMBApiKey();
      if (!mbApiKey) {
        reply("orders", {
          orders: [],
          mbInfos: {},
          error: "Chưa nhập MB API key — mở popup extension để nhập.",
          diag: { runId, source, stage: "no_api_key" },
        });
        return;
      }
      if (!data) break;

      const stats = {};
      let orders = [];
      try {
        orders = getOrders(data, mbApiKey, stats) || [];
      } catch (e) {
        console.error("[BK] getOrders error:", e);
        reply("orders", {
          orders: [],
          mbInfos: {},
          error: "Lỗi đọc dữ liệu đơn Etsy: " + (e?.message || e),
          diag: { runId, source, stage: "parse_error", ...stats },
        });
        return;
      }
      console.log("orders:", orders);

      const diag = { runId, source, ...stats, toCheck: orders.length, endpoint: preferredMBUrl };
      if (orders.length === 0) {
        reply("orders", {
          orders,
          mbInfos: {},
          error: null,
          diag: { ...diag, stage: "no_orders" },
        });
        return;
      }

      reply("syncDiag", { ...diag, stage: "checking" });
      const check = await checkSyncedOrdersOnMB(
        orders.map((o) => o["orderId"]),
        mbApiKey,
      );
      reply("orders", {
        orders,
        mbInfos: check.data || {},
        error: check.ok ? null : check.error,
        diag: {
          ...diag,
          stage: check.ok ? "checked" : "check_failed",
          attempts: check.attempts,
        },
      });
      break;
    }
    default:
      break;
  }
});

const openOrderPage = () => {
  const url = `https://www.etsy.com/your/orders/sold`;
  chrome.tabs.query({}, (tabs) => {
    let found = false;

    for (let tab of tabs) {
      if (found) break;
      if (tab?.url?.includes("/your/orders/sold")) {
        found = tab.id;
        break;
      }
    }

    if (found) {
      chrome.tabs.update(found, {
        active: true,
        url,
      });
    } else {
      chrome.tabs.create({
        active: true,
        url,
      });
    }
  });
};

chrome.runtime.onInstalled.addListener(details => {
  openOrderPage();

  const script = {
    id: 'injected',
    matches: ["https://www.etsy.com/*", "https://www.yuntrack.com/*"],
    js: ['injected.js'],
    world: 'MAIN',
    runAt: 'document_start'
  }

  chrome.scripting.registerContentScripts([script])
});
