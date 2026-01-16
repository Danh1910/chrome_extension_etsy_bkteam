$(document).ready(async function () { // Thêm async
   let { currencyConvert } = await getStorageData("currencyConvert"); // Dòng mới

   if (currencyConvert && typeof currencyConvert === "string") {
      currencyConvert = JSON.parse(currencyConvert);
      convert = !!currencyConvert.checked;
      convertVal = currencyConvert.value;
      if (convertVal) convertVal = convertVal.replace(",", ".");
      if (convert) $("#currency-convert").attr("checked", convert);
      if (convertVal) $("#change-result").val(parseFloat(convertVal));
   }
   $("#save-settings").on("click", function () {
      const checked = $("#currency-convert").is(":checked");
      var value = $("#change-result").val();
      if (value) value.replace(",", ".");
      notifySuccess("Settings success.");
      setStorageData({ currencyConvert: JSON.stringify({ checked, value }) }); // Dòng mới
   });
});
