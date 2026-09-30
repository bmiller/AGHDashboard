/* Apply the theme before first paint (loaded synchronously in <head>):
 * #light / #dark URL hash > stored choice > system preference > light.
 * Kept as a file rather than inline so the CSP can forbid inline scripts. */
(function () {
    "use strict";
    var t = null;
    if (location.hash === "#dark") t = "dark";
    else if (location.hash === "#light") t = "light";
    else {
        try { t = localStorage.getItem("agh-dash-theme"); } catch (e) { /* ignore */ }
        if (t !== "light" && t !== "dark") {
            t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
                ? "dark"
                : "light";
        }
    }
    document.documentElement.dataset.theme = t;
})();
