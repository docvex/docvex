// Shared table-of-contents highlighter for the legal document pages:
// marks the .lg-toc link whose section card is currently in view.
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('.lg-toc a[href^="#"]'));
  if (!links.length) return;
  var map = {};
  links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) {
        links.forEach(function (l) { l.classList.remove('is-active'); });
        var a = map[en.target.id]; if (a) a.classList.add('is-active');
      }
    });
  }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });
  document.querySelectorAll('.lg-card[id]').forEach(function (s) { obs.observe(s); });
})();
