// Applies the saved/system colour theme before first paint (no light flash).
// External file, not inline: the CSP is script-src 'self'.
(function () {
  try {
    var t = localStorage.getItem("ha-theme");
    var dark = t === "dark" || (t !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
  } catch (e) {}
})();
