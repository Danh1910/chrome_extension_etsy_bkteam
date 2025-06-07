// Thêm "lính canh" vào ngay đầu file
if (window.myEtsyInjectorHasRun) {
  // Nếu biến này đã tồn tại, tức là script đã chạy rồi -> không làm gì cả
  console.log("Injector script đã chạy, không thực thi lại.");
} else {
  // Nếu chưa chạy, đặt biến để đánh dấu và thực thi code
  window.myEtsyInjectorHasRun = true;

  // --- TOÀN BỘ CODE CŨ CỦA MÀY ĐẶT Ở ĐÂY ---
  const ENDPOINTS = [
    "/mission-control/orders\\?filters", // get list orders
  ];

  const { fetch: originFetch } = window;
  window.fetch = async (...args) => {
    const res = await originFetch(...args);
    const url = args[0];

  if (url && ENDPOINTS.some((i) => !!url.match(new RegExp(i, "gi")))) {
    res
        .clone()
        .json()
        .then((data) => {
          // <<< THÊM DÒNG NÀY VÀO ĐỂ DEBUG >>>
          console.log("INJECTED.JS: Fetched and posting data:", data);

          // Gửi tin nhắn đi
          window.postMessage({ type: "FROM_MY_EXTENSION", data: data });
        })
        .catch((e) => console.log(e?.toString()));
  }

  return res;
};
}