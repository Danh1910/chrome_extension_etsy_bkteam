// File: popup/popup.js (Đã cập nhật)

// Biến key, thống nhất với các file khác
const mbApi = "MBApi";

// Helper function để LƯU key vào bộ nhớ của extension
const saveMbApi = (apiKey) =>
    new Promise((resolve) => {
       chrome.storage.local.set({ [mbApi]: apiKey }).then(() => {
          resolve(apiKey);
       });
    });

// Helper function để LẤY key từ bộ nhớ của extension
const getMbApi = () =>
    new Promise((resolve) => {
       chrome.storage.local.get(mbApi).then((result) => {
          resolve(result[mbApi]);
       });
    });

// Sửa lại hàm xử lý sự kiện click "Save"
$(document).on("click", "#save", async function () {
   const value = $("#api_key").val();
   if (!value) {
      // Có thể thêm báo lỗi nếu cần
      return;
   }

   $(this).addClass("loader");

   // <<< THAY ĐỔI CỐT LÕI >>>
   // 1. Tự lưu API key vào chrome.storage.local
   await saveMbApi(value);

   // 2. Gửi tin nhắn đi để content_script biết và tải lại trang
   chrome.runtime.sendMessage({
      message: "popupSaveApiKey",
      data: value,
   });

   // 3. Tự đóng popup sau khi lưu
   // Không cần đợi phản hồi từ content script nữa
   setTimeout(() => {
      window.close();
   }, 300); // Đợi 0.3s cho đẹp
});


// Sửa lại hàm `document.ready` để tự lấy key khi popup mở
$(document).ready(async function () {
   $("#save").addClass("loader");
   const apiKey = await getMbApi(); // Tự lấy key từ storage
   if (apiKey) {
      $("#api_key").val(apiKey);
   }
   $("#save").removeClass("loader");
});


// Xóa bỏ listener cũ đi vì không cần nữa
// chrome.runtime.onMessage.addListener(...)