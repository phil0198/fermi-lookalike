// Applies the saved palette and light/dark choice before the page paints.
(function () {
  var s = {};
  try { s = (JSON.parse(localStorage.getItem("ballpark:v3")) || {}).settings || {}; } catch (e) { /* storage blocked */ }
  var root = document.documentElement;
  root.dataset.palette = s.palette || "classic";
  root.dataset.scheme = s.scheme || (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
})();
